package sandbox_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestLeaderWithdrawsQueuedClaimAndMemberAutomaticallyStartsTheNext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	release, started := make(chan struct{}), make(chan struct{})
	first := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First done"})
	first.Hold = release
	first.Expect = func(model.Request) error { close(started); return nil }
	next := enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Next done"})
	next.Expect = func(req model.Request) error {
		if !strings.Contains(fmt.Sprint(req.Messages), "Keep queued task") {
			return fmt.Errorf("wrong queued task started")
		}
		return nil
	}
	var withdrawn, kept task.Card
	step := 0
	leadModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
		if !strings.Contains(fmt.Sprint(req.Messages), "Update the queue") {
			return fake.Reply{Text: "Waiting."}
		}
		step++
		switch step {
		case 1:
			return enginetest.IntegrationCall("withdraw_claim", map[string]any{"task": withdrawn.ID, "claim": withdrawn.Claims[0].ID})
		case 2:
			return enginetest.IntegrationCall("set_task_priority", map[string]any{"task": kept.ID, "priority": 5})
		case 3:
			return enginetest.IntegrationCall("say", map[string]any{"text": "Queue updated"})
		default:
			return fake.Reply{Text: "Waiting."}
		}
	}}
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leadModel, "worker": fake.New(t, first, next)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	create := func(title string) task.Card {
		t.Helper()
		card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: title, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
		if err != nil {
			t.Fatal(err)
		}
		return card
	}
	create("Running task")
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	withdrawn = create("Withdraw queued task")
	kept = create("Keep queued task")
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{session.MessageCompleted, task.Reported}})
	defer stop()
	if _, err = e.SayGroup(ctx, g.ID, "", "human", group.Message{Text: "Update the queue"}); err != nil {
		t.Fatal(err)
	}
	reports := 0
	for {
		select {
		case fact := <-facts:
			if fact.Type == session.MessageCompleted && fact.Stream == event.Stream("group:"+g.ID) && !idleReply(fact) {
				card, err := e.Task(ctx, withdrawn.ID)
				if err != nil || card.Status != task.Open {
					t.Fatalf("queued claim was not withdrawn: %+v %v", card, err)
				}
				card, err = e.Task(ctx, kept.ID)
				if err != nil || card.Priority != 5 {
					t.Fatalf("priority=%d err=%v", card.Priority, err)
				}
				close(release)
			}
			if fact.Type == task.Reported {
				reports++
				if reports == 2 {
					if fact.Scope.Task != kept.ID {
						t.Fatal("wrong member task started")
					}
					return
				}
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

// idleReply reports whether a group message is the plain "Waiting." of a Leader that was woken and had nothing to do.
func idleReply(fact event.Event) bool {
	message, err := event.Decode[session.Completion](fact)
	return err == nil && len(message.Parts) == 1 && message.Parts[0].Text == "Waiting."
}
