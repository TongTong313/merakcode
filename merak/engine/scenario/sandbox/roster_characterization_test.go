package sandbox_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// A refused budget request currently reuses the error text about assigning a worker.
func TestOnlyTheGroupLeaderCanRequestAnAgentBudgetIncrease(t *testing.T) {
	for _, tc := range []struct {
		name         string
		member       event.ID
		wantError    string
		wantRequests int
		wantGrants   int
	}{
		{"leader requests owner approval", "leader", "", 1, 1},
		{"worker is refused", "worker", "task: only a worker member can be assigned", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			directory := t.TempDir()
			requests := make(chan permission.Request, 4)
			provider := enginetest.GroupScript{ProviderName: "fixture", Test: t, Reply: func(model.Request) fake.Reply {
				return fake.Reply{Text: "Waiting."}
			}}
			deps := enginetest.Deps(t)
			deps.Workdir = directory
			deps.Providers = map[string]model.Provider{"fixture": provider}
			deps.Ask = func(_ context.Context, request permission.Request) (permission.Reply, error) {
				requests <- request
				return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
			}
			e, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
			lead.ID, work.ID = "leader-profile", "worker-profile"
			lead.Model.Provider, work.Model.Provider = "fixture", "fixture"
			g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Budget approval", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
				{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
			}, []definition.Agent{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			card, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Bounded task", Workspace: "none", Budget: task.Budget{MaxTokens: 40}, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
			if err != nil {
				t.Fatal(err)
			}
			err = e.UpdateTask(ctx, card.ID, task.Update{Budget: &task.BudgetIncrease{Tokens: 100}, Reason: "Finish the remaining work"}, event.Actor{Kind: event.ActorAgent, ID: tc.member})
			message := ""
			if err != nil {
				message = err.Error()
			}
			if message != tc.wantError {
				t.Fatalf("budget request error=%q want=%q", message, tc.wantError)
			}
			if len(requests) != tc.wantRequests {
				t.Fatalf("approval requests=%d want=%d", len(requests), tc.wantRequests)
			}
			if tc.wantRequests == 1 {
				request := <-requests
				if request.Kind != "budget" || request.Member != "leader" || request.Spec.Name != "update_task" || request.Call.Env.Scope != (event.Scope{Group: g.ID, Task: card.ID}) {
					t.Fatalf("approval kind=%q member=%q tool=%q scope=%+v", request.Kind, request.Member, request.Spec.Name, request.Call.Env.Scope)
				}
				var input struct {
					Task       event.ID            `json:"task"`
					Reason     string              `json:"reason"`
					TaskBudget task.Budget         `json:"taskBudget"`
					Increase   task.BudgetIncrease `json:"increase"`
				}
				if err := json.Unmarshal(request.Call.Input, &input); err != nil {
					t.Fatal(err)
				}
				if input.Task != card.ID || input.Reason != "Finish the remaining work" || input.TaskBudget != (task.Budget{MaxTokens: 40}) || input.Increase != (task.BudgetIncrease{Tokens: 100}) {
					t.Fatalf("approval input=%+v", input)
				}
			}
			current, err := e.Task(ctx, card.ID)
			if err != nil {
				t.Fatal(err)
			}
			if current.Budget != (task.Budget{MaxTokens: 40}) || len(current.Grants) != tc.wantGrants {
				t.Fatalf("budget=%+v grants=%+v want grants=%d", current.Budget, current.Grants, tc.wantGrants)
			}
			if tc.wantGrants == 1 {
				grant := current.Grants[0]
				if grant.BudgetIncrease != (task.BudgetIncrease{Tokens: 100}) || grant.By != (event.Actor{Kind: event.ActorHuman, ID: "owner"}) {
					t.Fatalf("approved budget grant=%+v", grant)
				}
			}
		})
	}
}
