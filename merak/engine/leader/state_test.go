package leader_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

func TestGroupStateFoldsThreeTablesAndRendersTheFocusedTask(t *testing.T) {
	var state leader.State
	apply := func(kind event.Type, value any) {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := state.Apply(event.Event{ID: "fact", Type: kind, Payload: body}); err != nil {
			t.Fatal(err)
		}
	}
	apply(group.Created, group.State{Group: group.Group{ID: "group"}, Members: []group.Member{{ID: "member", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Status: group.Idle}}})
	first := task.Card{ID: "goal-a", Group: "group", Title: "First goal", Status: task.Running, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}, Claims: []task.Claim{{ID: "claim-a", Task: "goal-a", Member: "member", Status: task.ClaimActive}}}
	apply(task.Started, first)
	second := task.Card{ID: "goal-b", Group: "group", Title: strings.Repeat("Long title ", 100), Status: task.Queued, Claims: []task.Claim{{ID: "claim-b", Task: "goal-b", Member: "member", Status: task.ClaimQueued}}}
	apply(task.QueuedEvent, second)
	if len(state.Goals) != 2 || len(state.Tasks) != 2 || len(state.Members) != 1 || state.Members[0].Current != "goal-a" || state.Members[0].Queue != 1 {
		t.Fatalf("state=%+v", state.Snapshot())
	}
	first.Status = task.Review
	first.Claims[0].Status = task.ClaimReported
	first.Claims[0].Report = &task.Report{Claim: "claim-a", Verdict: task.VerdictDone, Summary: "Verified focused result"}
	apply(task.Reported, first)
	second.Status = task.Review
	second.Claims[0].Status = task.ClaimReported
	second.Claims[0].Report = &task.Report{Claim: "claim-b", Verdict: task.VerdictDone, Summary: strings.Repeat("Unrelated details ", 70)}
	apply(task.Reported, second)
	apply(task.Opened, task.Card{ID: "outside-child", Group: "group", Parent: "goal-b", Title: "Other subtree", Status: task.Open})
	text := state.Render(220, "goal-a")
	for _, expected := range []string{"Goals", "Tasks", "Members", "goal-a", "goal-b", "outside-child", "member", "fact", "Verified focused result"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("missing %q: %s", expected, text)
		}
	}
	if strings.Contains(text, "Unrelated details") || strings.Contains(text, "| outside-child |") || window.EstimateText(text) > 220 {
		t.Fatalf("render exceeded its scope or budget: %d %s", window.EstimateText(text), text)
	}
}

func TestGroupStateTracksEveryCollaboratingMember(t *testing.T) {
	var state leader.State
	apply := func(kind event.Type, value any) {
		t.Helper()
		body, _ := json.Marshal(value)
		if err := state.Apply(event.Event{Type: kind, Payload: body}); err != nil {
			t.Fatal(err)
		}
	}
	apply(group.Created, group.State{Group: group.Group{ID: "group"}, Members: []group.Member{
		{ID: "a", Name: "API", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "b", Name: "UI", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	}})
	card := task.Card{ID: "task", Group: "group", Status: task.Running, Claims: []task.Claim{
		{ID: "first", Task: "task", Member: "a", Status: task.ClaimActive},
		{ID: "second", Task: "task", Member: "b", Status: task.ClaimActive},
	}}
	apply(task.Started, card)
	for _, member := range state.Snapshot().Members {
		if member.Status != group.Busy || member.Current != "task" {
			t.Fatalf("active collaborator=%+v", member)
		}
	}
	card.Claims[0].Status = task.ClaimReported
	apply(task.Reported, card)
	view := state.Snapshot()
	if view.Members[0].Status != group.Idle || view.Members[1].Status != group.Busy {
		t.Fatalf("members=%+v", view.Members)
	}
}
