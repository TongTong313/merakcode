package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type groupScript struct {
	name  string
	reply func(model.Request) fake.Reply
	test  *testing.T
}

func (p groupScript) Name() string { return p.name }
func (p groupScript) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	return fake.New(p.test, p.reply(req)).Stream(ctx, req)
}

func TestLocalGroupDelegatesReportsAndDeliversWithoutIdleModelCalls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	var calls atomic.Int32
	progress := make(chan struct{}, 1)
	var child, goalID event.ID
	var e *engine.Engine
	call := func(id, name string, input any) fake.Reply {
		body, _ := json.Marshal(input)
		return fake.Reply{Calls: []model.ToolCall{{ID: id, Name: name, Input: body}}}
	}
	lead := groupScript{name: "leader-model", test: t, reply: func(req model.Request) fake.Reply {
		if !strings.Contains(req.System, "Role: leader") {
			t.Error("leader identity missing")
		}
		for _, spec := range req.Tools {
			if spec.Name == "bash" || spec.Name == "write_file" || spec.Name == "edit_file" {
				t.Errorf("leader received %s", spec.Name)
			}
		}
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if strings.Contains(part.Text, "(task.progress)") && !strings.Contains(part.Text, "(task.reported)") {
				if !strings.Contains(part.Text, "README inspected.") {
					t.Error("progress summary was lost")
				}
				select {
				case progress <- struct{}{}:
				default:
				}
				return fake.Reply{Text: "Progress received."}
			}
		}
		switch calls.Add(1) {
		case 1:
			return call("create", "create_task", map[string]any{"parent": goalID, "title": "Check README", "description": "Check the project documentation", "acceptance": []string{"Report the findings"}, "areas": []string{"README.md"}, "workspace": "none", "inputs": []string{"README.md"}, "priority": 4, "budget": map[string]any{"maxTokens": 100000}})
		case 2:
			last := req.Messages[len(req.Messages)-1]
			var card task.Card
			if len(last.Parts) != 1 || last.Parts[0].ToolResult == nil {
				t.Error("create_task did not produce a result")
				return fake.Reply{Text: "Missing task result"}
			}
			if err := json.Unmarshal([]byte(last.Parts[0].ToolResult.Parts[0].Text), &card); err != nil {
				t.Error(err)
			}
			child = card.ID
			if card.Budget.MaxTokens != 100000 {
				t.Errorf("task budget=%+v", card.Budget)
			}
			if card.Workspace != "none" || card.Priority != 4 || !reflect.DeepEqual(card.Inputs, []string{"README.md"}) {
				t.Errorf("task workspace settings=%+v", card)
			}
			if !reflect.DeepEqual(card.Areas, []string{"README.md"}) {
				t.Errorf("task areas=%v", card.Areas)
			}
			return call("assign", "assign_task", map[string]any{"task": child, "member": "worker"})
		case 3:
			return fake.Reply{Text: "Waiting for the assigned report."}
		case 4:
			return call("read", "read_report", map[string]any{"task": child})
		case 5:
			return call("premature", "notify_human", map[string]any{"kind": "final", "text": "Not ready yet"})
		case 6:
			last := req.Messages[len(req.Messages)-1]
			if len(last.Parts) != 1 || last.Parts[0].ToolResult == nil || !last.Parts[0].ToolResult.IsError {
				t.Error("premature delivery was not rejected")
			}
			card, err := e.Tasks.Get(ctx, child)
			if err != nil || card.Status == task.Done {
				t.Errorf("rejected final notice closed a child: %+v %v", card, err)
			}
			return call("doing", "set_phase", map[string]any{"phase": "doing"})
		case 7:
			return call("integrating", "set_phase", map[string]any{"phase": "integrating"})
		case 8:
			return call("notify", "notify_human", map[string]any{"kind": "final", "text": "README verified."})
		default:
			t.Error("unexpected leader request")
			return fake.Reply{Text: "Unexpected request"}
		}
	}}
	release := make(chan struct{})
	started := make(chan struct{})
	work := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "progress", Name: "report_progress", Input: json.RawMessage(`{"summary":"README inspected."}`)}}}, fake.Reply{Hold: release, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"README verified."}`)}}, Expect: func(req model.Request) error {
		close(started)
		if !strings.Contains(fmt.Sprint(req.Messages), "Check the project documentation") {
			return fmt.Errorf("task packet omitted the description")
		}
		return nil
	}}, fake.Reply{Text: "[]", Expect: func(req model.Request) error {
		if !strings.Contains(req.System, "Extract durable project facts") {
			return fmt.Errorf("unexpected worker request after submitting its report")
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader-model": lead, "worker-model": work}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	leaderProfile, workerProfile := agent.DefaultLeader(), agent.DefaultWorker()
	leaderProfile.ID, leaderProfile.Model.Provider = "leader-profile", "leader-model"
	workerProfile.ID, workerProfile.Model.Provider = "worker-profile", "worker-model"
	created, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: new(false)}}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: leaderProfile.ID, Owner: "human"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: workerProfile.ID, Owner: "human"},
	}, []agent.Agent{leaderProfile, workerProfile})
	if err != nil {
		t.Fatal(err)
	}
	events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: created.ID}})
	defer stop()
	goal, err := e.CreateTask(ctx, task.Card{Group: created.ID, Title: "Verify project", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}})
	if err != nil {
		t.Fatal(err)
	}
	goalID = goal.ID
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for calls.Load() < 3 {
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	select {
	case <-progress:
	case <-ctx.Done():
		t.Fatal("worker progress did not reach its Leader")
	}
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 3 {
		t.Fatal("idle leader called its model")
	}
	close(release)
	for {
		select {
		case fact := <-events:
			if fact.Type != "notice.sent" {
				continue
			}
			notice, _ := event.Decode[group.Notice](fact)
			if notice.Kind != "final" {
				continue
			}
			if !strings.Contains(string(fact.Payload), "README verified.") {
				t.Fatalf("notice=%s", fact.Payload)
			}
			facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: created.ID, Task: child}})
			if err != nil {
				t.Fatal(err)
			}
			var types []event.Type
			for _, fact := range facts {
				if strings.HasPrefix(string(fact.Type), "task.") {
					types = append(types, fact.Type)
				}
			}
			if !reflect.DeepEqual(types, []event.Type{"task.created", "task.opened", "task.queued", "task.started", "task.updated", "task.progress", "task.reported", "task.closed"}) {
				t.Fatalf("events=%v", types)
			}
			final, err := e.Tasks.Get(ctx, goal.ID)
			if err != nil || final.Status != task.Done {
				t.Fatalf("goal=%+v err=%v", final, err)
			}
			if calls.Load() != 8 {
				t.Fatalf("leader calls=%d", calls.Load())
			}
			for {
				view, err := e.GroupState(ctx, created.ID)
				if err == nil && len(view.Goals) == 1 && view.Goals[0].Status == task.Done {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatalf("group state was not persisted: %+v %v", view, err)
				case <-time.After(time.Millisecond):
				}
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestGroupsCanReuseAnExistingLeaderProfile(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "shared-profile", "fake"
	for _, id := range []event.ID{"leader-a", "leader-b"} {
		_, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: string(id), Project: group.Project{Directory: dir}, Leader: id}, []group.Member{{ID: id, Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID}}, []agent.Agent{p})
		if err != nil {
			t.Fatal(err)
		}
	}
}
