package leader_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestSentinelRulesUseEventsAndRuntimeState(t *testing.T) {
	now := time.Unix(200000, 0)
	claim := leader.ClaimView{Claim: "claim", Task: "task", Member: "worker", Session: "session", Active: true, Running: true, Started: now.Add(-time.Minute), LastActivity: now, LastEvent: "last"}
	call := func(id, name, input string) event.Event {
		body, _ := json.Marshal(model.ToolCall{ID: id, Name: name, Input: json.RawMessage(input)})
		return event.Event{ID: event.ID(id), Type: tool.Called, Time: now, Payload: body}
	}
	for _, tc := range []struct {
		name, rule string
		view       func() leader.SentinelView
	}{
		{"idle claim", "claim.idle", func() leader.SentinelView {
			c := claim
			c.Started = now.Add(-20 * time.Minute)
			c.LastActivity = now.Add(-16 * time.Minute)
			return leader.SentinelView{Claims: []leader.ClaimView{c}}
		}},
		{"dead process", "claim.exited", func() leader.SentinelView {
			c := claim
			c.Running = false
			return leader.SentinelView{Claims: []leader.ClaimView{c}}
		}},
		{"repeated tool", "session.loop", func() leader.SentinelView {
			c := claim
			c.Events = []event.Event{call("a", "read_file", `{"path":"x","offset":0}`), call("b", "read_file", `{"offset":0,"path":"x"}`), call("c", "read_file", `{"path":"x","offset":0}`)}
			return leader.SentinelView{Claims: []leader.ClaimView{c}}
		}},
		{"ten steps without progress", "session.loop", func() leader.SentinelView {
			c := claim
			for i := range 12 {
				c.Events = append(c.Events, call(fmt.Sprint(i), fmt.Sprint("tool-", i%2), fmt.Sprintf(`{"value":%d}`, i)))
			}
			return leader.SentinelView{Claims: []leader.ClaimView{c}}
		}},
		{"fast budget use", "claim.budget", func() leader.SentinelView {
			c := claim
			c.MaxTokens = 100
			body, _ := json.Marshal(session.Completion{Usage: model.Usage{Input: 40, Output: 11}})
			c.Events = []event.Event{{ID: "usage", Type: session.MessageCompleted, Payload: body}}
			return leader.SentinelView{Claims: []leader.ClaimView{c}}
		}},
		{"expired lease", "workspace.lease", func() leader.SentinelView {
			return leader.SentinelView{Leases: []leader.LeaseView{{Workspace: workspace.Workspace{ID: "workspace", Kind: workspace.KindInplace, Active: true, Claim: "claim", Task: "task"}, Ended: true}}}
		}},
		{"slow scan", "watch.overload", func() leader.SentinelView {
			return leader.SentinelView{Watch: []leader.WatchView{{Duration: time.Second + time.Nanosecond}}}
		}},
		{"too many files", "watch.overload", func() leader.SentinelView { return leader.SentinelView{Watch: []leader.WatchView{{Files: 50001}}} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			view := tc.view()
			view.Now = now
			found := leader.Inspect(view)
			if len(found) != 1 || found[0].Rule != tc.rule {
				t.Fatalf("findings=%+v", found)
			}
		})
	}
	claim.Preparing, claim.Running = true, false
	if found := leader.Inspect(leader.SentinelView{Now: now, Claims: []leader.ClaimView{claim}, Watch: []leader.WatchView{{Duration: time.Second, Files: 50000}}}); len(found) != 0 {
		t.Fatalf("exceptions=%+v", found)
	}
}

func TestBudgetPatrolIncludesUsageJustBeforeTheFiveMinuteBoundary(t *testing.T) {
	started := time.Unix(1000, 0)
	body, _ := json.Marshal(session.Completion{Usage: model.Usage{Input: 51}})
	claim := leader.ClaimView{Active: true, Running: true, Started: started, LastActivity: started.Add(5 * time.Minute), MaxTokens: 100, Events: []event.Event{{ID: "usage", Type: session.MessageCompleted, Time: started.Add(4*time.Minute + 59*time.Second), Payload: body}}}
	found := leader.Inspect(leader.SentinelView{Now: started.Add(5*time.Minute + 30*time.Second), Claims: []leader.ClaimView{claim}})
	if len(found) != 1 || found[0].Rule != "claim.budget" {
		t.Fatalf("findings=%+v", found)
	}
	claim.Events[0].Time = started.Add(5*time.Minute + time.Second)
	if found := leader.Inspect(leader.SentinelView{Now: started.Add(6 * time.Minute), Claims: []leader.ClaimView{claim}}); len(found) != 0 {
		t.Fatalf("late usage=%+v", found)
	}
}
