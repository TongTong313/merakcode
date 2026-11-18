package coordinator_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/builtin"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	admin "github.com/TongTong313/merakcode/merak/engine/feature/admin/definition"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
)

type coordinatorFixture struct {
	groups      *group.Manager
	coordinator *coordinator.Coordinator
	tasks       *task.Pool
	execution   *execution.Execution
	agents      *admin.Manager
	bus         *event.Bus
}

// newCoordinator assembles real collaborators for tests of the coordinator and its task pool.
func newCoordinator(t *testing.T, directory string, providers map[string]model.Provider) coordinatorFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	durable := storage.New()
	bus := event.NewBus(durable, time.Now, event.NewID)
	var workers sync.WaitGroup
	shared := &core.Core{Store: durable, Bus: bus, Ctx: ctx, Now: time.Now, NewID: event.NewID, Logger: slog.Default(), Workers: &workers, Workdir: directory}
	models := catalog.New()
	vault := vault.NewMemory()
	definitions := registry.New(registry.Deps{Core: shared, Catalog: models, Vault: vault, Providers: providers})
	groups := group.New(durable, bus, event.NewID)
	tasks := task.New(durable, bus, event.NewID, groups)
	board := task.NewBoard(tasks, groups, time.Now)
	workspaces := workspace.New(ctx, durable, bus, event.NewID)
	remoteDomain := new(remote.Remote)
	coord := new(coordinator.Coordinator)
	members := roster.New(roster.Deps{Core: shared, Registry: definitions, Groups: groups, Tasks: tasks, Execution: remoteDomain})
	tasks.AuthorizeAssignment = members.AuthorizeMemberAssignment
	permissions := &approval.Router{Bus: bus, Groups: groups, Tasks: tasks, TimedOut: coord.ApprovalTimedOut, Remote: remoteDomain.RouteDevicePermission}
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Router: permissions, Bus: bus, Grants: permission.NewGrants(func() permission.Settings { return definitions.NetworkConfiguration() })}
	notes := memory.New(durable)
	manager := session.NewManager(durable, bus)
	var execute *execution.Execution
	conversations := conversation.New(conversation.Deps{
		Core: shared, Registry: definitions, Manager: manager, Catalog: models, Notes: notes, Gate: gate, AskPermission: permissions.Ask, Tools: tool.NewPool("worker.default"),
		Hooks: conversation.Hooks{
			Environment: func(ctx context.Context, state *session.State, env *tool.Env) error {
				return execute.ConversationEnvironment(ctx, state, env)
			},
			Project: remoteDomain.ExecutionProject,
			Children: func(ctx context.Context, run conversation.ChildRun) conversation.Children {
				return builtin.New(ctx, bus, event.NewID, run)
			},
			ChildAgent: builtin.AgentOf,
			BeforeTurn: []func(context.Context, *conversation.Conversation) (func(loop.Outcome), error){func(ctx context.Context, c *conversation.Conversation) (func(loop.Outcome), error) {
				return execute.ConversationBudget(ctx, c)
			}},
			AfterTurn: []func(context.Context, *conversation.Conversation, event.ID, conversation.EndStage) error{func(ctx context.Context, c *conversation.Conversation, id event.ID, stage conversation.EndStage) error {
				return execute.ConversationRelease(ctx, c, id, stage)
			}},
		},
	})
	runnerFor := func(p definition.Agent, _ *sandbox.Launcher) worker.Runner {
		return &builtin.Adapter{Bus: bus, Execute: func(ctx context.Context, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
			return execute.RunAssignment(ctx, p, a, steer)
		}}
	}
	execute = execution.New(execution.Deps{Core: shared, Registry: definitions, Roster: members, Conversation: conversations, Manager: manager, Groups: groups, Tasks: tasks, Catalog: models, Notes: notes, Gate: gate, Permissions: permissions, AskPermission: permissions.Ask, RunnerFor: runnerFor, RemoteCredentials: remoteDomain.RemoteCredentials, WorkerTools: coord.WorkerTools})
	remote.New(remoteDomain, remote.Deps{Core: shared, Roster: members, Execution: execute, Groups: groups, Tasks: tasks, Workspaces: workspaces, Permissions: permissions, Vault: vault, AskQuestion: coord.RouteQuestion(nil), RunnerFor: runnerFor, ApprovalTimedOut: coord.ApprovalTimedOut})
	bus.Route = remoteDomain.DeviceStream
	coordinator.New(coord, coordinator.Deps{Core: shared, Registry: definitions, Conversation: conversations, Roster: members, Execution: execute, Remote: remoteDomain, Catalog: models, Notes: notes, Manager: manager, Groups: groups, Tasks: tasks, Board: board, Workspaces: workspaces, Gate: gate, Permissions: permissions, AskQuestion: coord.RouteQuestion(nil), RunnerFor: runnerFor})
	agents := admin.New(admin.Deps{Core: shared, Registry: definitions, Groups: groups, Vault: vault})
	t.Cleanup(func() {
		cancel()
		coord.Barrier()
		execute.Barrier()
		conversations.Barrier()
		workers.Wait()
		workspaces.Close()
	})
	return coordinatorFixture{groups: groups, coordinator: coord, tasks: tasks, execution: execute, agents: agents, bus: bus}
}

func (f coordinatorFixture) createGroup(t *testing.T, ctx context.Context, owner event.ID, g group.Group, members []group.Member, profiles []definition.Agent) (group.Group, error) {
	t.Helper()
	for _, profile := range profiles {
		if _, err := f.agents.SaveAgent(ctx, owner, profile); err != nil {
			return group.Group{}, err
		}
	}
	return f.coordinator.CreateGroup(ctx, g, members)
}

type groupScript struct {
	name  string
	reply func(model.Request) fake.Reply
	test  *testing.T
}

func (p groupScript) Name() string { return p.name }
func (p groupScript) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	return fake.New(p.test, p.reply(req)).Stream(ctx, req)
}

func integrationCall(name string, input any) fake.Reply {
	body, _ := json.Marshal(input)
	return fake.Reply{Calls: []model.ToolCall{{ID: string(event.NewID()), Name: name, Input: body}}}
}

func enterGoalIntegration(t *testing.T, ctx context.Context, f coordinatorFixture, id event.ID) {
	t.Helper()
	card, err := f.tasks.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for card.Parent != "" {
		card, err = f.tasks.Get(ctx, card.Parent)
		if err != nil {
			t.Fatal(err)
		}
	}
	state, err := f.groups.Get(ctx, card.Group)
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
	if card.Phase == task.PhasePlanning {
		if err := f.execution.UpdateTask(ctx, card.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
			t.Fatal(err)
		}
	}
	if card.Phase == task.PhasePlanning || card.Phase == task.PhaseDoing {
		if err := f.execution.UpdateTask(ctx, card.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
			t.Fatal(err)
		}
	}
}

func waitGoalPhase(t *testing.T, ctx context.Context, f coordinatorFixture, id event.ID, phase task.Phase) {
	t.Helper()
	for {
		card, err := f.tasks.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if card.Phase == phase {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("phase=%s want=%s: %v", card.Phase, phase, ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
}
