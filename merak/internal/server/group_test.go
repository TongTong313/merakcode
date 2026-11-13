package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestTaskRPCChecksTheHumanRoleBeforeCancelling(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	clients := map[string]*protocol.Client{"owner": connectServerAs(t, handler, host, "owner", protocol.Capabilities{}), "approver": connectServerAs(t, handler, host, "approver", protocol.Capabilities{})}
	g, err := e.Groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Group", Project: group.Project{Directory: t.TempDir()}, Leader: "a"}, []group.Member{
		{ID: "a", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
	})
	if err != nil {
		t.Fatal(err)
	}
	card, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := e.Tasks.Create(ctx, task.Card{Group: g.ID, Parent: card.ID, Title: "Child task"})
	if err != nil {
		t.Fatal(err)
	}
	for _, human := range []string{"approver", "owner"} {
		var result task.Card
		err := clients[human].Call(ctx, "task.cancel", protocol.TaskCancelParams{Task: child.ID}, &result)
		if human == "approver" {
			if err == nil {
				t.Fatal("approver cancelled a child task")
			}
			continue
		}
		if err != nil || result.Status != task.Cancelled {
			t.Fatalf("child=%+v err=%v", result, err)
		}
		parent, err := e.Tasks.Get(ctx, card.ID)
		if err != nil || parent.Status == task.Cancelled {
			t.Fatalf("parent=%+v err=%v", parent, err)
		}
	}
	for _, method := range []string{"task.cancel"} {
		if method == "task.cancel" {
			for _, phase := range []task.Phase{task.PhaseDoing, task.PhaseStalled, task.PhaseDoing} {
				var resumed task.Card
				if err := clients["owner"].Call(ctx, "task.update", map[string]any{"task": card.ID, "phase": phase}, &resumed); err != nil {
					t.Fatal(err)
				}
				if resumed.Phase != phase {
					t.Fatalf("phase=%s", resumed.Phase)
				}
			}
		}
		params := map[string]any{"task": card.ID}
		if err := clients["approver"].Call(ctx, method, params, new(task.Card)); err == nil {
			t.Fatalf("approver used %s", method)
		}
		var result task.Card
		if err := clients["owner"].Call(ctx, method, params, &result); err != nil {
			t.Fatal(err)
		}
		if method == "task.cancel" && (result.Status != task.Cancelled || result.Phase != task.PhaseCancelled) {
			t.Fatalf("cancelled=%+v", result)
		}
	}
}

func TestGroupRPCPublishesATaskAndExposesItsLeaderState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Task received."})}})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "token")
	defer handler.Close()
	host := httptest.NewServer(handler)
	defer host.Close()
	client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	p := agent.DefaultMerakCode()
	p.ID, p.Model.Provider = "leader-profile", "fake"
	params := protocol.GroupCreateParams{Group: group.Group{Kind: "cloud", Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, Members: []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: p.ID}}}
	var created group.Group
	if err := client.Call(ctx, "group.create", params, &created); err == nil || err.Error() != "MRK-1006" {
		t.Fatalf("unsupported group: %v", err)
	}
	if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: p}, nil); err != nil {
		t.Fatal(err)
	}
	params.Kind = group.KindLocal
	params.Members = append(params.Members, group.Member{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner})
	if err := client.Call(ctx, "group.create", params, &created); err != nil {
		t.Fatal(err)
	}
	p = agent.DefaultMerakCode()
	p.ID, p.Model.Provider = "worker-profile", "fake"
	if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: p}, nil); err != nil {
		t.Fatal(err)
	}
	var member group.Member
	if err := client.Call(ctx, "group.addMember", protocol.GroupAddMemberParams{Group: created.ID, Member: group.Member{Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: p.ID}}, &member); err != nil {
		t.Fatal(err)
	}
	if member.ID == "" || member.Group != created.ID {
		t.Fatalf("member=%+v", member)
	}
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Group: created.ID}}, new(protocol.SubscribeResult)); err != nil {
		t.Fatal(err)
	}
	var card task.Card
	if err := client.Call(ctx, "task.create", map[string]any{"group": created.ID, "title": "Verify project", "areas": []string{"docs"}}, &card); err != nil {
		t.Fatal(err)
	}
	if len(card.Areas) != 1 || card.Areas[0] != "docs" {
		t.Fatalf("areas=%v", card.Areas)
	}
	for {
		select {
		case fact := <-client.Events:
			if fact.Type != "turn.finished" {
				continue
			}
			if fact.Scope.Group != created.ID || fact.Scope.Task != "" || fact.Actor.ID != "leader" {
				t.Fatalf("thread attribution=%+v", fact)
			}
			var view leader.View
			if err := client.Call(ctx, "group.state", protocol.GroupIDParams{Group: created.ID}, &view); err != nil {
				t.Fatal(err)
			}
			if len(view.Tasks) != 1 || len(view.Members) != 3 || view.LastSeq == 0 {
				t.Fatalf("view=%+v", view)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestGroupRPCSupportsHumanMessagesAssignmentAndReview(t *testing.T) {
	for _, direct := range []bool{false, true} {
		t.Run(fmt.Sprintf("direct assignment %t", direct), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			dir := t.TempDir()
			replies := make([]fake.Reply, 12)
			for i := range replies {
				replies[i] = fake.Reply{Text: "Waiting."}
			}
			report := func(summary string) fake.Reply {
				body, _ := json.Marshal(map[string]string{"verdict": "done", "summary": summary})
				return fake.Reply{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: body}}}
			}
			e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"leader": fake.New(t, replies...), "worker": fake.New(t, report("Initial"), report("Revised"))}})
			if err != nil {
				t.Fatal(err)
			}
			handler := server.New(e, "token")
			defer handler.Close()
			host := httptest.NewServer(handler)
			defer host.Close()
			client, err := protocol.Connect(ctx, "ws"+strings.TrimPrefix(host.URL, "http"), "token", protocol.HelloParams{Protocol: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			unknown := connectServerAs(t, handler, host, "unknown", protocol.Capabilities{})
			lead, work := agent.DefaultMerakCode(), agent.DefaultMerakCode()
			lead.ID, lead.Model.Provider = "leader-profile", "leader"
			work.ID, work.Model.Provider = "worker-profile", "worker"
			work.Memory = []memory.Scope{}
			for _, a := range []agent.Agent{lead, work} {
				if err := client.Call(ctx, "agent.save", protocol.AgentSaveParams{Agent: a}, nil); err != nil {
					t.Fatal(err)
				}
			}
			var g group.Group
			err = client.Call(ctx, "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: dir}, Leader: "leader"}, Members: []group.Member{
				{ID: "local-human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			}}, &g)
			if err != nil {
				t.Fatal(err)
			}
			if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Group: g.ID}}, new(protocol.SubscribeResult)); err != nil {
				t.Fatal(err)
			}
			var said event.ID
			if err := unknown.Call(ctx, "group.say", map[string]any{"group": g.ID, "text": "Hello"}, &said); err == nil {
				t.Fatal("nonmember spoke")
			}
			if err := client.Call(ctx, "group.say", map[string]any{"group": g.ID, "text": "Hello"}, &said); err != nil {
				t.Fatal(err)
			}
			if said == "" {
				t.Fatal("missing message id")
			}
			params := map[string]any{"group": g.ID, "title": "Review work", "review": true, "priority": 3, "workspace": "none", "inputs": []string{"reference.md"}}
			if direct {
				params["member"] = "worker"
			}
			var card task.Card
			if err := client.Call(ctx, "task.create", params, &card); err != nil {
				t.Fatal(err)
			}
			if !card.Review || card.Priority != 3 || card.CreatedBy.ID != "local-human" {
				t.Fatalf("card=%+v", card)
			}
			if card.Workspace != "none" || len(card.Inputs) != 1 || card.Inputs[0] != "reference.md" {
				t.Fatalf("workspace input was lost: %+v", card)
			}
			if !direct {
				if err := unknown.Call(ctx, "task.assign", map[string]any{"task": card.ID, "member": "worker"}, new(task.Claim)); err == nil {
					t.Fatal("nonmember assigned work")
				}
				if err := client.Call(ctx, "task.assign", map[string]any{"task": card.ID, "member": "worker"}, new(task.Claim)); err != nil {
					t.Fatal(err)
				}
			}
			receipt := false
			reports := 0
			for {
				select {
				case fact := <-client.Events:
					if fact.Type == group.NoticeSent && fact.Cause == said {
						receipt = true
					}
					if fact.Type != task.Reported {
						continue
					}
					reports++
					decision, feedback := "rework", "Revise it"
					if reports == 2 {
						decision, feedback = "approve", ""
						for _, phase := range []task.Phase{task.PhaseDoing, task.PhaseIntegrating, task.PhaseReview} {
							if err := e.Tasks.SetPhase(ctx, card.ID, phase, event.Actor{Kind: event.ActorAgent, ID: "leader"}); err != nil {
								t.Fatal(err)
							}
						}
					}
					if err := client.Call(ctx, "task.review", map[string]any{"task": card.ID, "decision": decision, "feedback": feedback}, new(struct{})); err != nil {
						t.Fatal(err)
					}
					if reports == 2 {
						current, err := e.Tasks.Get(ctx, card.ID)
						if err != nil || current.Status != task.Done || !receipt {
							t.Fatalf("task=%+v receipt=%v err=%v", current, receipt, err)
						}
						return
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}
