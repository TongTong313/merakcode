package sandbox_test

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
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestWorktreeReviewBlocksMergeUntilTheHumanApproves(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	dir := enginetest.IntegrationRepository(t)
	rejected := make(chan struct{}, 1)
	leadModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
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
			return enginetest.IntegrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := fake.New(t, enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'Reviewed\\n' > result.txt && git add result.txt && git commit -m 'Review fixture'"}), enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Verified committed result."}))
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"leader": leadModel, "worker": workModel}
	deps.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: new(false)}}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{"merge.done", task.Closed}})
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
	enginetest.EnterGoalIntegration(t, ctx, e, card.ID)
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
	dir := enginetest.IntegrationRepository(t)
	var calls atomic.Int32
	leadModel := enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(req model.Request) fake.Reply {
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
			return enginetest.IntegrationCall("request_merge", map[string]any{"task": card.ID, "claim": card.Claims[0].ID})
		}
		return fake.Reply{Text: "Waiting."}
	}}
	workModel := enginetest.GroupScript{ProviderName: "worker", Test: t, Reply: func(req model.Request) fake.Reply {
		switch calls.Add(1) {
		case 1:
			if !strings.Contains(req.System, "result.txt") {
				t.Error("worker did not receive the check command")
			}
			return enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'bad\\n' > result.txt && git add result.txt && git commit -m 'Failing fixture'"})
		case 2:
			return enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "First result"})
		case 3:
			body, _ := json.Marshal(req.Messages)
			if !strings.Contains(string(body), "check expected good") {
				t.Error("rework lost the check output")
			}
			if _, err := os.Stat(filepath.Join(dir, "result.txt")); !os.IsNotExist(err) {
				t.Errorf("failed check changed the target: %v", err)
			}
			return enginetest.IntegrationCall("bash", map[string]any{"command": "printf 'good\\n' > result.txt && git add result.txt && git commit -m 'Passing fixture'"})
		case 4:
			return enginetest.IntegrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Revised result"})
		default:
			t.Error("unexpected worker request")
			return fake.Reply{Text: "Unexpected"}
		}
	}}
	deps2 := enginetest.Deps(t)
	deps2.Workdir = dir
	deps2.Providers = map[string]model.Provider{"leader": leadModel, "worker": workModel}
	deps2.Ask = func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Review: new(false)}, Brief: group.Brief{Check: "grep -qx good result.txt || { echo 'check expected good'; exit 1; }"}}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported, task.Closed}})
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
				enginetest.EnterGoalIntegration(t, ctx, e, card.ID)
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
