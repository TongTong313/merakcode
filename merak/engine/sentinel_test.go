package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestSentinelDoesNotFlagSuccessfulFileChangesAsNoProgress(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	ready := make(chan struct{})
	var replies []fake.Reply
	for i := range 12 {
		replies = append(replies, integrationCall("write_file", map[string]any{"path": fmt.Sprintf("changed-%d.txt", i), "content": "changed"}))
	}
	replies = append(replies, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(ready); return nil }})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), SentinelInterval: 10 * time.Millisecond, Providers: map[string]model.Provider{"writer": fake.New(t, replies...)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.SentinelFlagged}})
	defer stop()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "writer", Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.Send(ctx, id, []model.Part{{Text: "Write files"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case fact := <-facts:
		t.Fatalf("file progress was flagged: %s", fact.Payload)
	case <-time.After(80 * time.Millisecond):
	}
}

func TestSentinelContinuesAfterAStreamingBurstOverflowsItsSubscription(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	reply := integrationCall("list_dir", map[string]any{"path": "."})
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), SentinelInterval: 10 * time.Millisecond, Providers: map[string]model.Provider{"loop": fake.New(t, reply, reply, reply, fake.Reply{Hold: make(chan struct{})})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	processors := runtime.GOMAXPROCS(1)
	for range 10000 {
		if _, err = e.Bus.Publish(ctx, event.Event{Type: session.MessageDelta, Stream: "session:noise", Scope: event.Scope{Session: "noise"}, Payload: json.RawMessage(`{"text":"x"}`)}); err != nil {
			runtime.GOMAXPROCS(processors)
			t.Fatal(err)
		}
	}
	runtime.GOMAXPROCS(processors)
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.SentinelFlagged}})
	defer stop()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "loop"})
	if err != nil {
		t.Fatal(err)
	}
	if err = e.Send(ctx, id, []model.Part{{Text: "Inspect"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("streaming overflow stopped the sentinel")
	}
}

func TestSentinelDetectsLoopsInConversationsAndLeaderThreads(t *testing.T) {
	for _, target := range []string{"conversation", "leader"} {
		t.Run(target, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			name, input := "list_dir", map[string]any{"path": "."}
			if target == "leader" {
				name, input = "list_tasks", map[string]any{}
			}
			replies := []fake.Reply{integrationCall(name, input), integrationCall(name, input), integrationCall(name, input), {Hold: make(chan struct{})}}
			e, err := engine.New(engine.Deps{Workdir: t.TempDir(), SentinelInterval: 20 * time.Millisecond, Providers: map[string]model.Provider{"loop": fake.New(t, replies...)}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.SentinelFlagged}})
			defer stop()
			notices, stopNotices := e.Bus.Subscribe(event.Filter{Types: []event.Type{group.NoticeSent}})
			defer stopNotices()
			if target == "conversation" {
				id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "loop"})
				if err != nil {
					t.Fatal(err)
				}
				if err = e.Send(ctx, id, []model.Part{{Text: "Inspect files"}}); err != nil {
					t.Fatal(err)
				}
			} else {
				lead := agent.DefaultMerakCode()
				lead.ID, lead.Model.Provider = "lead", "loop"
				g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Loop", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead})
				if err != nil {
					t.Fatal(err)
				}
				if _, err = e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Inspect repeatedly", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case fact := <-facts:
				finding, _ := event.Decode[leader.Finding](fact)
				if finding.Rule != "session.loop" || len(finding.Evidence) != 3 || finding.Session == "" {
					t.Fatalf("finding=%+v", finding)
				}
			case <-ctx.Done():
				t.Fatal("session loop was not detected")
			}
			if target == "leader" {
				for {
					select {
					case fact := <-notices:
						value, _ := event.Decode[group.Notice](fact)
						if value.Kind == "sentinel" && len(value.To) == 1 && value.To[0] == "owner" {
							return
						}
					case <-ctx.Done():
						t.Fatal("loop finding did not reach the owner's inbox")
					}
				}
			}
		})
	}
}

func TestSentinelInterruptsOrphanClaimAndReleasesItsLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Second)
	defer cancel()
	storage := memory.New()
	stamp := time.Now().Add(-time.Minute)
	bus := event.NewBus(storage, func() time.Time { stamp = stamp.Add(time.Millisecond); return stamp }, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Patrol", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-merakcode", Owner: "owner"}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := groups.AddMember(ctx, g.ID, group.Member{ID: "other", Name: "Other", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-merakcode"}); err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Orphan", Workspace: workspace.KindInplace, Budget: task.Budget{MaxTokens: 100}})
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.Open(ctx, card.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Assign(ctx, card.ID, "worker", task.RoleOwner, []string{"a"}); err != nil {
		t.Fatal(err)
	}
	claim, err := pool.Next(ctx, "worker")
	if err != nil {
		t.Fatal(err)
	}
	spaces := workspace.New(ctx, storage, bus, event.NewID)
	defer spaces.Close()
	ws, err := spaces.ForClaim(ctx, g.Project.Directory, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.BindWorkspace(ctx, claim.ID, ws.ID); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(session.Completion{Usage: model.Usage{Input: 60}})
	if _, err = bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + claim.Session), Scope: event.Scope{Group: g.ID, Task: card.ID, Session: claim.Session}, Type: session.MessageCompleted, Payload: body}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Assign(ctx, card.ID, "other", task.RoleCollaborator, []string{"b"}); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Next(ctx, "other"); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Store: storage, SentinelInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	if err = e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	flagged, notified, released, budget := false, false, false, false
	for !flagged || !notified || !released || !budget {
		select {
		case fact := <-facts:
			switch fact.Type {
			case engine.SentinelFlagged:
				var finding leader.Finding
				if err = json.Unmarshal(fact.Payload, &finding); err != nil {
					t.Fatal(err)
				}
				flagged = flagged || finding.Rule == "claim.exited" && finding.Claim == claim.ID && finding.Task == card.ID
				budget = budget || finding.Rule == "claim.budget" && finding.Claim == claim.ID
			case group.NoticeSent:
				notice, _ := event.Decode[group.Notice](fact)
				notified = notified || notice.Kind == "sentinel" && len(notice.To) == 1 && notice.To[0] == "owner"
			case workspace.Released:
				released = true
			}
		case <-ctx.Done():
			t.Fatalf("flagged=%v notified=%v released=%v", flagged, notified, released)
		}
	}
	changed, err := e.Tasks.Get(ctx, card.ID)
	if err != nil || changed.Status != task.Blocked || changed.Claims[0].Status != task.ClaimInterrupted {
		t.Fatalf("card=%+v err=%v", changed, err)
	}
	saved, err := e.Workspaces.Get(ctx, ws.ID)
	if err != nil || saved.Active || saved.Released {
		t.Fatalf("lease=%+v err=%v", saved, err)
	}
}

func TestExitedWorkerWithoutReportInterruptsClaim(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead", "leader"
	work.ID, work.Mode = "work", permission.ModeTakeover
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	work.Product = &agent.Product{Kind: worker.KindCommand, Binary: binary, Args: []string{"--workspace-setup-fixture", "fail"}}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Exit", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{engine.SentinelFlagged}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Exit without report", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		finding, _ := event.Decode[leader.Finding](fact)
		if finding.Rule != "claim.exited" || finding.Task != card.ID {
			t.Fatalf("finding=%+v", finding)
		}
		saved, err := e.Tasks.Get(ctx, card.ID)
		if err != nil || saved.Status != task.Blocked || saved.Claims[0].Status != task.ClaimInterrupted || saved.Claims[0].Report != nil {
			t.Fatalf("task=%+v err=%v", saved, err)
		}
	case <-ctx.Done():
		t.Fatal("exited process was not interrupted")
	}
}

func TestSentinelCountsClaimUsageAgainstTaskBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	reply := integrationCall("list_dir", map[string]any{"path": "."})
	reply.Usage = &model.Usage{Input: 60, Output: 1}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), SentinelInterval: 10 * time.Millisecond, Providers: map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }},
		"worker": fake.New(t, reply, fake.Reply{Hold: make(chan struct{})}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead", "leader"
	work.ID, work.Model.Provider = "work", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Budget", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID, Owner: "owner"}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{engine.SentinelFlagged}})
	defer stop()
	var card task.Card
	if err = json.Unmarshal([]byte(`{"title":"Budgeted task","budget":{"maxTokens":100}}`), &card); err != nil {
		t.Fatal(err)
	}
	card.Group, card.CreatedBy = g.ID, event.Actor{Kind: event.ActorHuman, ID: "owner"}
	card, err = e.CreateAssignedTask(ctx, card, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		finding, _ := event.Decode[leader.Finding](fact)
		if finding.Rule != "claim.budget" || finding.Task != card.ID || len(finding.Evidence) != 1 {
			t.Fatalf("finding=%+v", finding)
		}
	case <-ctx.Done():
		t.Fatal("claim usage did not trigger task budget warning")
	}
}

func TestUnansweredQuestionUsesGroupTimeoutAndFlagsItsTask(t *testing.T) {
	for _, name := range []string{"ask_user", "ask_leader"} {
		t.Run(name, func(t *testing.T) { unansweredQuestionTimeout(t, name) })
	}
}

func unansweredQuestionTimeout(t *testing.T, name string) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }},
		"worker": fake.New(t, integrationCall(name, map[string]any{"text": "Choose a target"}), fake.Reply{Hold: make(chan struct{})}),
	}, AskQuestion: func(ctx context.Context, _ question.Request) (question.Answer, error) {
		<-ctx.Done()
		return question.Answer{}, ctx.Err()
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Timeout", Project: group.Project{Directory: t.TempDir()}, Leader: "leader", Settings: group.Settings{ApprovalTimeout: 30 * time.Millisecond}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{engine.SentinelFlagged}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Question", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		finding, _ := event.Decode[leader.Finding](fact)
		if finding.Rule != "approval.timeout" || finding.Task != card.ID {
			t.Fatalf("finding=%+v", finding)
		}
		saved, err := e.Tasks.Get(ctx, card.ID)
		if err != nil || saved.Status != task.Blocked {
			t.Fatalf("task=%+v err=%v", saved, err)
		}
	case <-ctx.Done():
		t.Fatal("question did not time out")
	}
}
