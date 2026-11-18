package sandbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func coordinatorGroup(t *testing.T, ctx context.Context, e *engine.Engine, directory string) group.Group {
	t.Helper()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "coordinator-leader", "leader"
	work.ID, work.Model.Provider = "coordinator-worker", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Coordination", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func coordinatorCompletion(t *testing.T, ctx context.Context, facts <-chan event.Event, id string) tool.Completion {
	t.Helper()
	for {
		select {
		case fact := <-facts:
			if fact.Type != tool.Completed {
				continue
			}
			result, err := event.Decode[tool.Completion](fact)
			if err != nil {
				t.Fatal(err)
			}
			if result.CallID == id {
				return result
			}
		case <-ctx.Done():
			t.Fatalf("tool %s did not finish: %v", id, ctx.Err())
		}
	}
}

func TestLeaderCannotApproveAnOwnerOnlyBudgetRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	requests := make(chan permission.Request, 1)
	replies := make(chan permission.Reply, 1)
	expression := regexp.MustCompile(`Review owner approval ([A-Z0-9]+)`)
	leader := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply {
		body, _ := json.Marshal(request.Messages[len(request.Messages)-1])
		if match := expression.FindStringSubmatch(string(body)); len(match) == 2 {
			input, _ := json.Marshal(map[string]string{"request": match[1], "decision": "allow"})
			return fake.Reply{Calls: []model.ToolCall{{ID: "owner-only", Name: "approve", Input: input}}}
		}
		return fake.Reply{Text: "Waiting."}
	}}
	directory := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"leader": leader}
	deps.Ask = func(ctx context.Context, request permission.Request) (permission.Reply, error) {
		select {
		case requests <- request:
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
		select {
		case reply := <-replies:
			return reply, nil
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); e.Close() }()
	g := coordinatorGroup(t, ctx, e, directory)
	card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Bounded work", Workspace: "none", Budget: task.Budget{MaxTokens: 40}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		finished <- e.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{Tokens: 100}, Reason: "Finish the remaining work"}, event.Actor{Kind: event.ActorAgent, ID: "leader"})
	}()
	var pending permission.Request
	select {
	case pending = <-requests:
	case <-ctx.Done():
		t.Fatal("owner approval was not requested")
	}
	if pending.Kind != "budget" || pending.ID == "" {
		t.Fatalf("pending approval = %+v", pending)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed}})
	defer stop()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Review owner approval " + string(pending.ID), To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	result := coordinatorCompletion(t, ctx, facts, "owner-only")
	if result.Name != "approve" || !result.IsError || result.Code != "MRK-5001" || len(result.Parts) != 1 || result.Parts[0].Text != "this approval requires a human" {
		t.Fatalf("leader approval result = %+v", result)
	}
	current, err := e.Task(ctx, card.ID)
	if err != nil || len(current.Grants) != 0 {
		t.Fatalf("grant before owner reply = %+v, error = %v", current.Grants, err)
	}
	replies <- permission.Reply{Decision: permission.Allow, Human: "owner"}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("owner approval did not finish the budget request")
	}
	current, err = e.Task(ctx, card.ID)
	if err != nil || len(current.Grants) != 1 || current.Grants[0].Tokens != 100 || current.Grants[0].By != (event.Actor{Kind: event.ActorHuman, ID: "owner"}) {
		t.Fatalf("grant after owner reply = %+v, error = %v", current.Grants, err)
	}
}

func TestLeaderBudgetToolRequiresOwnerApprovalAndRejectsTasksOutsideTheGroup(t *testing.T) {
	for _, scenario := range []struct {
		name         string
		decision     permission.Decision
		outside      bool
		wantError    string
		wantRequests int
		wantGrants   int
	}{
		{"owner allows", permission.Allow, false, "", 1, 1},
		{"owner denies", permission.Deny, false, "MRK-5002", 1, 0},
		{"task is outside the group", permission.Allow, true, "task is outside this leader thread", 0, 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			requests := make(chan permission.Request, 1)
			expression := regexp.MustCompile(`Increase task budget ([A-Z0-9]+)`)
			leader := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply {
				body, _ := json.Marshal(request.Messages[len(request.Messages)-1])
				if match := expression.FindStringSubmatch(string(body)); len(match) == 2 {
					input, _ := json.Marshal(map[string]any{"task": match[1], "reason": "Finish the remaining work", "budget": map[string]int{"tokens": 100}})
					return fake.Reply{Calls: []model.ToolCall{{ID: "increase-budget", Name: "update_task", Input: input}}}
				}
				return fake.Reply{Text: "Waiting."}
			}}
			directory := t.TempDir()
			deps2 := enginetest.Deps(t)
			deps2.Workdir = directory
			deps2.Providers = map[string]model.Provider{"leader": leader}
			deps2.Ask = func(ctx context.Context, request permission.Request) (permission.Reply, error) {
				select {
				case requests <- request:
					return permission.Reply{Decision: scenario.decision, Human: "owner"}, nil
				case <-ctx.Done():
					return permission.Reply{}, ctx.Err()
				}
			}
			e, err := engine.New(deps2)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); e.Close() }()
			g := coordinatorGroup(t, ctx, e, directory)
			taskGroup := g.ID
			if scenario.outside {
				taskGroup = ""
			}
			card, err := e.CreateTask(ctx, task.Card{Group: taskGroup, Project: directory, Title: "Bounded work", Workspace: "none", Budget: task.Budget{MaxTokens: 40}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed}})
			defer stop()
			if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Increase task budget " + string(card.ID), To: []event.ID{"leader"}}); err != nil {
				t.Fatal(err)
			}
			result := coordinatorCompletion(t, ctx, facts, "increase-budget")
			if result.Name != "update_task" || result.IsError != (scenario.wantError != "") || len(result.Parts) != 1 {
				t.Fatalf("budget tool result = %+v", result)
			}
			if scenario.wantError != "" && (result.Code != "MRK-5001" || result.Parts[0].Text != scenario.wantError) {
				t.Fatalf("budget tool error = %+v, want %q", result, scenario.wantError)
			}
			if len(requests) != scenario.wantRequests {
				t.Fatalf("owner requests = %d, want %d", len(requests), scenario.wantRequests)
			}
			if scenario.wantRequests == 1 {
				request := <-requests
				if request.Kind != "budget" || request.Member != "leader" || request.Call.Env.Scope != (event.Scope{Group: g.ID, Task: card.ID}) {
					t.Fatalf("owner request = %+v", request)
				}
			}
			current, err := e.Task(ctx, card.ID)
			if err != nil || current.Budget != (task.Budget{MaxTokens: 40}) || len(current.Grants) != scenario.wantGrants {
				t.Fatalf("budget = %+v, grants = %+v, error = %v", current.Budget, current.Grants, err)
			}
			if scenario.wantGrants == 1 {
				if current.Grants[0].Tokens != 100 || current.Grants[0].By != (event.Actor{Kind: event.ActorHuman, ID: "owner"}) {
					t.Fatalf("owner grant = %+v", current.Grants[0])
				}
				var returned task.Card
				if err := json.Unmarshal([]byte(result.Parts[0].Text), &returned); err != nil || returned.ID != card.ID || len(returned.Grants) != 1 || returned.Grants[0].Tokens != 100 {
					t.Fatalf("returned task = %+v, error = %v", returned, err)
				}
			}
		})
	}
}

func TestLeaderMessagesRejectInvalidRecipientsAndReachTheRunningMember(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	started, finish := make(chan struct{}), make(chan struct{})
	worker := fake.New(t,
		fake.Reply{Text: "Waiting for instructions.", Hold: finish, Expect: func(model.Request) error { close(started); return nil }},
		fake.Reply{Expect: func(request model.Request) error {
			body, _ := json.Marshal(request.Messages)
			if !strings.Contains(string(body), "Use the revised instructions.") {
				return errors.New("running member did not receive the leader message")
			}
			return nil
		}, Calls: []model.ToolCall{{ID: "message-report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Received the leader message.","artifacts":[],"checks":[]}`)}}},
	)
	leader := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(request model.Request) fake.Reply {
		body, _ := json.Marshal(request.Messages[len(request.Messages)-1])
		if strings.Contains(string(body), "Send revised instructions now.") {
			return fake.Reply{Calls: []model.ToolCall{
				{ID: "message-unknown-field", Name: "message_member", Input: json.RawMessage(`{"member":"worker","text":"Ignored","extra":true}`)},
				{ID: "message-empty", Name: "message_member", Input: json.RawMessage(`{"member":"worker","text":" "}`)},
				{ID: "message-idle", Name: "message_member", Input: json.RawMessage(`{"member":"leader","text":"Ignored"}`)},
				{ID: "message-active", Name: "message_member", Input: json.RawMessage(`{"member":"worker","text":"Use the revised instructions."}`)},
			}}
		}
		return fake.Reply{Text: "Waiting."}
	}}
	directory := t.TempDir()
	deps3 := enginetest.Deps(t)
	deps3.Workdir = directory
	deps3.Providers = map[string]model.Provider{"leader": leader, "worker": worker}
	e, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); e.Close() }()
	g := coordinatorGroup(t, ctx, e, directory)
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Wait for instructions", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("member did not start")
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{tool.Completed}})
	defer stop()
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Send revised instructions now.", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct{ id, message string }{
		{"message-unknown-field", `json: unknown field "extra"`},
		{"message-empty", "member and message text are required"},
		{"message-idle", "member has no active claim in this thread"},
	} {
		result := coordinatorCompletion(t, ctx, facts, expected.id)
		if result.Name != "message_member" || !result.IsError || result.Code != "MRK-5001" || len(result.Parts) != 1 || result.Parts[0].Text != expected.message {
			t.Fatalf("message rejection = %+v, want %q", result, expected.message)
		}
	}
	result := coordinatorCompletion(t, ctx, facts, "message-active")
	var claim event.ID
	if result.IsError || len(result.Parts) != 1 || json.Unmarshal([]byte(result.Parts[0].Text), &claim) != nil || claim != card.Claims[0].ID {
		t.Fatalf("message delivery = %+v, want claim %s", result, card.Claims[0].ID)
	}
	close(finish)
	enginetest.WaitFor(t, ctx, "the member report after the leader message", func() bool {
		current, err := e.Task(ctx, card.ID)
		return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
	})
	current, err := e.Task(ctx, card.ID)
	if err != nil || current.Claims[0].Report == nil || current.Claims[0].Report.Summary != "Received the leader message." || current.Claims[0].Report.Verdict != task.VerdictDone {
		t.Fatalf("member report = %+v, error = %v", current, err)
	}
}

func TestPausingAGroupSteersTheActiveMemberAndResumingStartsItsQueuedTask(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	started, finish := make(chan struct{}), make(chan struct{})
	worker := fake.New(t,
		fake.Reply{Text: "Working.", Hold: finish, Expect: func(model.Request) error { close(started); return nil }},
		fake.Reply{Expect: func(request model.Request) error {
			body, _ := json.Marshal(request.Messages)
			if !strings.Contains(string(body), "Pause requested. Stop work safely and submit a blocked report describing your current progress.") {
				return errors.New("active member did not receive the pause instructions")
			}
			return nil
		}, Calls: []model.ToolCall{{ID: "pause-report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"blocked","summary":"Stopped safely with progress saved.","artifacts":[],"checks":[]}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "resumed-report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Finished the queued task after resuming.","artifacts":[],"checks":[]}`)}}},
	)
	leader := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}
	directory := t.TempDir()
	deps4 := enginetest.Deps(t)
	deps4.Workdir = directory
	deps4.Providers = map[string]model.Provider{"leader": leader, "worker": worker}
	e, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); e.Close() }()
	g := coordinatorGroup(t, ctx, e, directory)
	active, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Active task", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("member did not start")
	}
	body, _ := json.Marshal(group.Control{Thread: g.ID, Code: "MRK-4004"})
	if _, err := e.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Type: group.Paused, Actor: event.Actor{Kind: event.ActorAgent, ID: "leader"}, Payload: body}); err != nil {
		t.Fatal(err)
	}
	queued, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Queued task", Workspace: "none", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	facts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Task: queued.ID}, Types: []event.Type{task.QueuedEvent}})
	if err != nil || len(facts) != 1 {
		t.Fatalf("queued events = %v, error = %v", facts, err)
	}
	// The later queue event confirms that the group has finished handling the pause.
	enginetest.WaitFor(t, ctx, "the group to process the queued task after pausing", func() bool {
		view, err := e.GroupState(ctx, g.ID)
		return err == nil && view.LastSeq >= facts[0].Seq
	})
	close(finish)
	enginetest.WaitFor(t, ctx, "the active member to report its paused progress", func() bool {
		current, err := e.Task(ctx, active.ID)
		return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
	})
	current, err := e.Task(ctx, active.ID)
	if err != nil || current.Claims[0].Report == nil || current.Claims[0].Report.Verdict != task.VerdictBlocked || current.Claims[0].Report.Summary != "Stopped safely with progress saved." {
		t.Fatalf("paused member report = %+v, error = %v", current, err)
	}
	current, err = e.Task(ctx, queued.ID)
	if err != nil || len(current.Claims) != 1 || current.Claims[0].Status != task.ClaimQueued {
		t.Fatalf("queued task started while paused: %+v, error = %v", current, err)
	}
	if _, err := e.SayGroup(ctx, g.ID, "", "owner", group.Message{Text: "Continue the queued work.", To: []event.ID{"leader"}}); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the queued task to report after resuming", func() bool {
		current, err := e.Task(ctx, queued.ID)
		return err == nil && len(current.Claims) == 1 && current.Claims[0].Status == task.ClaimReported
	})
	current, err = e.Task(ctx, queued.ID)
	if err != nil || current.Claims[0].Report == nil || current.Claims[0].Report.Verdict != task.VerdictDone || current.Claims[0].Report.Summary != "Finished the queued task after resuming." {
		t.Fatalf("resumed member report = %+v, error = %v", current, err)
	}
}
