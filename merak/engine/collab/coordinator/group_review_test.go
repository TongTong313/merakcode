package coordinator_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"strings"
	"testing"
	"time"
)

func TestHumanReviewRequiresApprovalAndReworkKeepsTheClaimSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First report"})
	second := integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised report"})
	second.Expect = func(req model.Request) error {
		body, _ := json.Marshal(req.Messages)
		text := string(body)
		if !strings.Contains(text, "Revise the summary") || !strings.Contains(text, "First report") {
			return fmt.Errorf("rework lost the feedback or previous conversation")
		}
		return nil
	}
	dir := t.TempDir()
	f := newCoordinator(t, dir, map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Awaiting human review."} }},
		"worker": fake.New(t, first, second),
	})
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := f.createGroup(t, ctx, "human", group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := f.bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	card, err := f.coordinator.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Review work", Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	waitReport := func() task.Card {
		t.Helper()
		select {
		case fact := <-facts:
			card, err := event.Decode[task.Card](fact)
			if err != nil {
				t.Fatal(err)
			}
			return card
		case <-ctx.Done():
			t.Fatal(ctx.Err())
			return task.Card{}
		}
	}
	firstCard := waitReport()
	if err := f.tasks.Close(ctx, card.ID, task.Done); err == nil {
		t.Fatal("task closed without human approval")
	}
	if err := f.coordinator.ReviewTask(ctx, card.ID, "human", "rework", "Revise the summary"); err != nil {
		t.Fatal(err)
	}
	secondCard := waitReport()
	if secondCard.Claims[0].Session != firstCard.Claims[0].Session || secondCard.Claims[0].ID != firstCard.Claims[0].ID || secondCard.Claims[0].Report.Summary != "Revised report" {
		t.Fatalf("claim was replaced: first=%+v second=%+v", firstCard.Claims, secondCard.Claims)
	}
	enterGoalIntegration(t, ctx, f, card.ID)
	waitGoalPhase(t, ctx, f, card.ID, task.PhaseReview)
	if err := f.coordinator.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
		t.Fatal(err)
	}
	finished, err := f.tasks.Get(ctx, card.ID)
	if err != nil || finished.Status != task.Done {
		t.Fatalf("task=%+v err=%v", finished, err)
	}
}
