package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/task"
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
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Awaiting human review."} }},
		"worker": fake.New(t, first, second),
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	work.Memory = []memory.Scope{}
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
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Review work", Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
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
	if err := e.Tasks.Close(ctx, card.ID, task.Done); err == nil {
		t.Fatal("task closed without human approval")
	}
	if err := e.ReviewTask(ctx, card.ID, "human", "rework", "Revise the summary"); err != nil {
		t.Fatal(err)
	}
	secondCard := waitReport()
	if secondCard.Claims[0].Session != firstCard.Claims[0].Session || secondCard.Claims[0].ID != firstCard.Claims[0].ID || secondCard.Claims[0].Report.Summary != "Revised report" {
		t.Fatalf("claim was replaced: first=%+v second=%+v", firstCard.Claims, secondCard.Claims)
	}
	enterGoalIntegration(t, ctx, e, card.ID)
	waitGoalPhase(t, ctx, e, card.ID, task.PhaseReview)
	if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
		t.Fatal(err)
	}
	finished, err := e.Tasks.Get(ctx, card.ID)
	if err != nil || finished.Status != task.Done {
		t.Fatalf("task=%+v err=%v", finished, err)
	}
}

func TestWorktreeReviewBlocksMergeUntilTheHumanApproves(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := integrationRepository(t)
	rejected := make(chan struct{}, 1)
	leadModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			if part.ToolResult != nil {
				if part.ToolResult.IsError && strings.Contains(fmt.Sprint(part.ToolResult.Parts), "approval") {
					rejected <- struct{}{}
				}
				return fake.Reply{Text: "Waiting for human approval."}
			}
			if !strings.Contains(part.Text, "(task.reported)") {
				continue
			}
			index := strings.Index(part.Text, "):\n")
			var card task.Card
			if index < 0 || json.NewDecoder(strings.NewReader(part.Text[index+3:])).Decode(&card) != nil {
				t.Error("missing report event")
				return fake.Reply{Text: "Invalid report"}
			}
			return integrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := fake.New(t, integrationCall("bash", map[string]any{"command": "printf 'Reviewed\\n' > result.txt && git add result.txt && git commit -m 'Review fixture'"}), integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified committed result."}))
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leadModel, "worker": workModel}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: new(false)}}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"merge.done", task.Closed}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Review result", Review: true, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-rejected:
	case fact := <-facts:
		t.Fatalf("integration happened before approval: %s", fact.Type)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := os.Stat(filepath.Join(dir, "result.txt")); !os.IsNotExist(err) {
		t.Fatalf("target changed before approval: %v", err)
	}
	enterGoalIntegration(t, ctx, e, card.ID)
	if err := e.ReviewTask(ctx, card.ID, "human", "approve", ""); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case fact := <-facts:
			if fact.Type != task.Closed {
				continue
			}
			body, err := os.ReadFile(filepath.Join(dir, "result.txt"))
			if err != nil || string(body) != "Reviewed\n" {
				t.Fatalf("result=%q err=%v", body, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestFailedGroupCheckReturnsTheOriginalClaimForRework(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := integrationRepository(t)
	var calls atomic.Int32
	leadModel := groupScript{name: "leader", test: t, reply: func(req model.Request) fake.Reply {
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			index := strings.Index(part.Text, "(task.reported):\n")
			if index < 0 {
				continue
			}
			var card task.Card
			if err := json.NewDecoder(strings.NewReader(part.Text[index+len("(task.reported):\n"):])).Decode(&card); err != nil {
				t.Error(err)
				continue
			}
			return integrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := groupScript{name: "worker", test: t, reply: func(req model.Request) fake.Reply {
		switch calls.Add(1) {
		case 1:
			if !strings.Contains(req.System, "result.txt") {
				t.Error("worker did not receive the check command")
			}
			return integrationCall("bash", map[string]any{"command": "printf 'bad\\n' > result.txt && git add result.txt && git commit -m 'Failing fixture'"})
		case 2:
			return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First result"})
		case 3:
			body, _ := json.Marshal(req.Messages)
			if !strings.Contains(string(body), "check expected good") {
				t.Error("rework lost the check output")
			}
			if _, err := os.Stat(filepath.Join(dir, "result.txt")); !os.IsNotExist(err) {
				t.Errorf("failed check changed the target: %v", err)
			}
			return integrationCall("bash", map[string]any{"command": "printf 'good\\n' > result.txt && git add result.txt && git commit -m 'Passing fixture'"})
		case 4:
			return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised result"})
		default:
			t.Error("unexpected worker request")
			return fake.Reply{Text: "Unexpected"}
		}
	}}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": leadModel, "worker": workModel}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: new(false)}, Brief: group.Brief{Check: "grep -qx good result.txt || { echo 'check expected good'; exit 1; }"}}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported, task.Closed}})
	defer stop()
	_, err = e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Check result", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "human"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	var first task.Claim
	reports := 0
	for {
		select {
		case fact := <-facts:
			card, err := event.Decode[task.Card](fact)
			if err != nil {
				t.Fatal(err)
			}
			if fact.Type == task.Reported {
				if reports == 1 && card.Phase != task.PhaseDoing {
					t.Fatalf("failed check did not return to doing: %s", card.Phase)
				}
				enterGoalIntegration(t, ctx, e, card.ID)
				reports++
				if reports == 1 {
					first = card.Claims[0]
				} else if card.Claims[0].ID != first.ID || card.Claims[0].Session != first.Session || card.Claims[0].Workspace != first.Workspace {
					t.Fatal("rework replaced the claim resources")
				}
			}
			if fact.Type == task.Closed {
				body, err := os.ReadFile(filepath.Join(dir, "result.txt"))
				if err != nil || string(body) != "good\n" || reports != 2 {
					t.Fatalf("result=%q reports=%d err=%v", body, reports, err)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
