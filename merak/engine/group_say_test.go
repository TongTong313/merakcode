package engine_test

import (
	"context"
	"fmt"
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
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestGroupHumanMessageGetsAnImmediateReceiptAndPreemptsTheLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	started := make(chan struct{})
	reply := integrationCall("say", map[string]any{"text": "I will use the new requirement."})
	reply.Expect = func(req model.Request) error {
		if !strings.Contains(fmt.Sprint(req.Messages), "New requirement") {
			return fmt.Errorf("leader missed human input")
		}
		return nil
	}
	provider := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}, reply)
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultLeader()
	p.ID, p.Model.Provider = "profile", "fake"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID, Owner: "human"},
	}, []agent.Agent{p})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}})
	defer stop()
	if _, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Initial requirement"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	id, err := e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "New requirement"})
	if err != nil {
		t.Fatal(err)
	}
	receipts, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Group: g.ID}, Types: []event.Type{group.NoticeSent}})
	if err != nil || len(receipts) != 2 || receipts[1].Cause != id {
		t.Fatalf("receipts=%+v err=%v", receipts, err)
	}
	preempted := false
	for {
		select {
		case fact := <-facts:
			if fact.Type == "turn.preempted" {
				preempted = true
			}
			if fact.Type != session.MessageCompleted || fact.Stream != event.Stream("group:"+g.ID) {
				continue
			}
			message, err := event.Decode[session.Completion](fact)
			if err != nil || !preempted || len(message.Parts) != 1 || message.Parts[0].Text != "I will use the new requirement." {
				t.Fatalf("message=%+v preempted=%v err=%v", message, preempted, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestHumanMessagesReachActiveClaimsWithoutWakingTheLeader(t *testing.T) {
	for _, name := range []string{"mentioned member", "task discussion", "before assignment"} {
		t.Run(name, func(t *testing.T) {
			before := name == "before assignment"
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			started, received, finish := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var leaderCalls atomic.Int32
			leaderModel := groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { leaderCalls.Add(1); return fake.Reply{Text: "Waiting for work."} }}
			report := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified updated work."})
			report.Hold = finish
			report.Expect = func(req model.Request) error {
				if !strings.Contains(fmt.Sprint(req.Messages), "Apply this change") {
					return fmt.Errorf("worker did not receive the human message")
				}
				close(received)
				return nil
			}
			replies := []fake.Reply{report}
			if !before {
				replies = append([]fake.Reply{{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}}, replies...)
			}
			workerModel := fake.New(t, replies...)
			dir := t.TempDir()
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leaderModel, "worker": workerModel}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead, work := agent.DefaultLeader(), agent.DefaultWorker()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			work.ID, work.Model.Provider = "worker-profile", "worker"
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
				{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			}, []agent.Agent{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Work", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}})
			if err != nil {
				t.Fatal(err)
			}
			for leaderCalls.Load() == 0 {
				select {
				case <-time.After(time.Millisecond):
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			if !before {
				if _, err := e.Tasks.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
					t.Fatal(err)
				}
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			taskID := event.ID("")
			message := group.Message{Text: "Apply this change", To: []event.ID{"worker"}}
			if name != "mentioned member" {
				taskID = card.ID
				message.To = nil
			}
			if _, err := e.SayGroup(ctx, g.ID, taskID, "human", message); err != nil {
				t.Fatal(err)
			}
			if before {
				if _, err := e.Tasks.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-received:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			time.Sleep(30 * time.Millisecond)
			if leaderCalls.Load() != 1 {
				t.Fatalf("routed message woke leader: %d", leaderCalls.Load())
			}
			close(finish)
		})
	}
}

func TestAnIdleMentionOrExplicitAssignmentStartsTheWorkerDirectly(t *testing.T) {
	for _, mention := range []bool{false, true} {
		name := "task with member"
		if mention {
			name = "idle member mention"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			started := make(chan struct{})
			workerModel := fake.New(t, fake.Reply{Hold: make(chan struct{}), Expect: func(req model.Request) error {
				if !strings.Contains(fmt.Sprint(req.Messages), "Inspect the design") {
					return fmt.Errorf("assignment text missing")
				}
				close(started)
				return nil
			}})
			dir := t.TempDir()
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": fake.New(t), "worker": workerModel}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead, work := agent.DefaultLeader(), agent.DefaultWorker()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			work.ID, work.Model.Provider = "worker-profile", "worker"
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
				{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			}, []agent.Agent{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			if mention {
				_, err = e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Inspect the design", To: []event.ID{"worker"}})
			} else {
				_, err = e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Inspect the design", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			cards, err := e.Tasks.List(ctx, g.ID)
			if err != nil || len(cards) != 1 || len(cards[0].Claims) != 1 || cards[0].Claims[0].Member != "worker" {
				t.Fatalf("cards=%+v err=%v", cards, err)
			}
			cancel()
		})
	}
}
