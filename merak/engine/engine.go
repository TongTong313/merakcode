// Package engine assembles the conversation modules.
package engine

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/agent/web"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/acp"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/builtin"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/codex"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/command"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/opencode"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/pi"
	workerremote "github.com/TongTong313/merakcode/merak/engine/collab/worker/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	admindefinition "github.com/TongTong313/merakcode/merak/engine/feature/admin/definition"
	adminmcp "github.com/TongTong313/merakcode/merak/engine/feature/admin/mcp"
	adminmemory "github.com/TongTong313/merakcode/merak/engine/feature/admin/memory"
	adminskill "github.com/TongTong313/merakcode/merak/engine/feature/admin/skill"
	"github.com/TongTong313/merakcode/merak/engine/feature/project"
	"github.com/TongTong313/merakcode/merak/engine/feature/review"
	"github.com/TongTong313/merakcode/merak/engine/feature/sessions"
	"github.com/TongTong313/merakcode/merak/engine/feature/terminal"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// Dirs contains working directories selected and owned by the caller.
type Dirs struct {
	Snapshots    string // Shadow Git repositories of sessions.
	Worktrees    string // Parent of the worktrees directory.
	SkillCache   string // Downloaded skill sources.
	SandboxState string // Sandbox state and lock files.
	Temporary    string // Connection checks, product extensions and sandbox setup scripts.
}

type Deps struct {
	Dial wire.Dial
	// NewLink creates the link of one cloud login. Nil means this engine has no cloud.
	NewLink          func() wire.Link
	SentinelInterval time.Duration
	// ScheduleInterval is how often due scheduled tasks are looked for; the default is one minute.
	ScheduleInterval time.Duration
	MCPCommand       string
	ApprovalTimeout  time.Duration
	DataDir          string
	// Vault keeps secrets and must be supplied by the caller.
	Vault           credential.Vault
	Dirs            Dirs
	NetworkSettings registry.NetworkSettings
	AskQuestion     func(context.Context, question.Request) (question.Answer, error)
	Logger          *slog.Logger
	MemoryIdle      time.Duration
	// Store keeps engine state and must be supplied by the caller.
	Store     store.Store
	Catalog   *catalog.Catalog
	Providers map[string]model.Provider
	Model     string
	Thinking  model.Thinking
	Now       func() time.Time
	NewID     func() event.ID
	Workdir   string
	System    string
	ToolPool  string
	Deferred  []tool.Tool
	Ask       func(context.Context, permission.Request) (permission.Reply, error)
}

type externalConversations struct{ engine *Engine }

func (a externalConversations) Create(ctx context.Context, agent definition.Agent, options conversation.SessionOptions) (event.ID, error) {
	return a.engine.execution.CreateExternalChat(ctx, agent, options)
}

func (a externalConversations) Send(ctx context.Context, id event.ID, parts []model.Part) (bool, error) {
	return a.engine.execution.SendExternalSession(ctx, id, parts)
}

type Engine struct {
	adminMemory     *adminmemory.Manager
	adminMCP        *adminmcp.Manager
	adminSkill      *adminskill.Manager
	adminDefinition *admindefinition.Manager
	project         *project.Project
	sessions        *sessions.Sessions
	coordinator     *coordinator.Coordinator
	remote          *remote.Remote
	execution       *execution.Execution
	roster          *roster.Roster
	conversation    *conversation.Manager
	core            *core.Core
	registry        *registry.Registry
	workspaces      *workspace.Manager
	terminals       *terminal.Manager
	cancel          context.CancelFunc
	shutdownOnce    sync.Once
	shutdownDone    chan struct{}
	shutdownErr     error
}

func New(d Deps) (*Engine, error) {
	if d.Vault == nil {
		return nil, fmt.Errorf("credential vault is required")
	}
	if d.Store == nil {
		return nil, fmt.Errorf("store is required")
	}
	if d.Dirs.Snapshots == "" || d.Dirs.Worktrees == "" || d.Dirs.SkillCache == "" || d.Dirs.SandboxState == "" || d.Dirs.Temporary == "" {
		return nil, fmt.Errorf("working directories are required")
	}
	if runtime.GOOS == "windows" {
		launcher := &sandbox.Launcher{StateDir: d.Dirs.SandboxState}
		launcher.Status(context.Background(), sandbox.Profile{})
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewID == nil {
		d.NewID = event.NewID
	}
	if d.ToolPool == "" {
		d.ToolPool = "worker.default"
	}
	if d.ToolPool != "worker.default" && d.ToolPool != "worker.readonly" {
		return nil, fmt.Errorf("unknown tool pool %q", d.ToolPool)
	}
	e := &Engine{
		project:     &project.Project{},
		sessions:    &sessions.Sessions{},
		coordinator: &coordinator.Coordinator{},
		remote:      &remote.Remote{},
	}
	vault := d.Vault
	bus := event.NewBus(d.Store, d.Now, d.NewID)
	tools := tool.NewPool(d.ToolPool)
	e.terminals = terminal.New(bus, d.NewID)
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	var workers sync.WaitGroup
	e.core = &core.Core{Store: d.Store, Now: d.Now, NewID: d.NewID, Ctx: ctx, Bus: bus, Logger: d.Logger, Workers: &workers, DataDir: d.DataDir, Workdir: d.Workdir}
	if d.Catalog == nil {
		d.Catalog = catalog.New()
	}
	catalog := d.Catalog
	e.registry = registry.New(registry.Deps{Core: e.core, Catalog: catalog, Vault: vault, NetworkSettings: d.NetworkSettings, Providers: d.Providers})
	bus.Route = e.remote.DeviceStream
	groups := group.New(d.Store, bus, e.core.NewID)
	tasks := task.New(d.Store, bus, e.core.NewID, groups)
	board := task.NewBoard(tasks, groups, d.Now)
	e.roster = roster.New(roster.Deps{Core: e.core, Registry: e.registry, Groups: groups, Tasks: tasks, Execution: e.remote})
	tasks.AuthorizeAssignment = e.roster.AuthorizeMemberAssignment
	permissions := &approval.Router{Bus: bus, Groups: groups, Tasks: tasks, Human: d.Ask, Timeout: d.ApprovalTimeout}
	permissions.TimedOut = e.coordinator.ApprovalTimedOut
	permissions.Remote = e.remote.RouteDevicePermission
	askQuestion := e.coordinator.RouteQuestion(d.AskQuestion)
	askPermission := permissions.Ask
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Router: permissions, Bus: bus, Grants: permission.NewGrants(func() permission.Settings { return e.registry.NetworkConfiguration() })}
	runnerFor := func(p definition.Agent, launcher *sandbox.Launcher) worker.Runner {
		if p.Product != nil {
			switch p.Product.Kind {
			case definition.KindRemote:
				source := definition.RemoteSource{}
				if p.Product.Remote != nil {
					source = *p.Product.Remote
				}
				return &workerremote.Runner{Dial: d.Dial, Source: source, Bus: bus, Store: e.core.Store, Credentials: func(ctx context.Context) (wire.RemoteConnectParams, error) {
					return e.remote.RemoteCredentials(ctx, source.Connection)
				}, Import: func(ctx context.Context, fact event.Event) error {
					return e.remote.ImportRemoteEvent(ctx, source.Connection, fact)
				}, Reply: e.remote.ReplyRemoteEvent}
			case definition.KindClaudeCode:
				return &claudecode.Runner{Sandbox: launcher, Bus: bus, Store: e.core.Store, Gate: gate, Product: *p.Product, System: p.System}
			case definition.KindCodex:
				return &codex.Runner{Sandbox: launcher, Bus: bus, Store: e.core.Store, Gate: gate, Product: *p.Product, System: p.System}
			case definition.KindOpenCode:
				return &opencode.Runner{Sandbox: launcher, Bus: bus, Store: e.core.Store, Gate: gate, Product: *p.Product, System: p.System}
			case definition.KindPi:
				return &pi.Runner{Temporary: d.Dirs.Temporary, Sandbox: launcher, Bus: bus, Store: e.core.Store, Product: *p.Product, System: p.System}
			case definition.KindACP:
				return &acp.Runner{Sandbox: launcher, Bus: bus, Store: e.core.Store, Gate: gate, Product: *p.Product, System: p.System}
			case definition.KindCommand:
				return &command.Runner{Sandbox: launcher, Bus: bus, Store: e.core.Store, Product: *p.Product}
			}
		}
		return &builtin.Adapter{Bus: bus, Execute: func(ctx context.Context, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
			return e.execution.RunAssignment(ctx, p, a, steer)
		}}
	}
	notes := memory.New(d.Store)
	e.shutdownDone = make(chan struct{})
	manager := session.NewManager(d.Store, bus)
	e.workspaces = workspace.New(e.core.Ctx, d.Store, bus, e.core.NewID)
	for _, t := range []tool.Tool{tool.Spawn{}, tool.WaitChild{}, tool.ReadFile{Memory: notes}, tool.Remember{Memory: notes}, tool.Recall{Memory: notes}, tool.WriteFile{}, tool.EditFile{}, tool.Bash{}, tool.Glob{}, tool.Grep{}, tool.ListDir{}, tool.Lookup{Store: d.Store}, tool.BashOutput{}, tool.TodoWrite{}, tool.WritePlan{}, tool.MultiEdit{}, tool.DocxRead{}, tool.ExcelRead{}, tool.ExcelWrite{}, web.Fetch{}, web.Search{}, web.Code{}} {
		if d.ToolPool == "worker.readonly" && t.Spec().Effect != tool.EffectRead {
			continue
		}
		tools.Tools[t.Spec().Name] = gate.Wrap(t)
	}
	tools.Deferred = make(map[string]tool.Tool)
	if d.ToolPool != "worker.readonly" {
		tools.Tools["ask_user"] = tool.AskUser{Bus: bus, Ask: askQuestion}
	}
	for _, t := range d.Deferred {
		if d.ToolPool == "worker.readonly" && t.Spec().Effect != tool.EffectRead {
			continue
		}
		tools.Deferred[t.Spec().Name] = gate.Wrap(t)
		delete(tools.Tools, t.Spec().Name)
	}
	e.conversation = conversation.New(conversation.Deps{
		Core: e.core, Registry: e.registry, Manager: manager, Catalog: catalog,
		Notes: notes, Gate: gate, AskPermission: permissions.Ask,
		Model: d.Model, Thinking: d.Thinking, System: d.System, Tools: tools,
		MemoryIdle: d.MemoryIdle,
		Hooks: conversation.Hooks{
			External: externalConversations{engine: e},
			Stop: []func(event.ID) bool{e.coordinator.StopLeaderTurn, func(id event.ID) bool {
				return e.execution.StopExternalChat(id)
			}},
			Environment: func(ctx context.Context, state *session.State, env *tool.Env) error {
				return e.execution.ConversationEnvironment(ctx, state, env)
			},
			Project: e.remote.ExecutionProject,
			Children: func(ctx context.Context, run conversation.ChildRun) conversation.Children {
				return builtin.New(ctx, bus, e.core.NewID, run)
			},
			ChildAgent: builtin.AgentOf,
			Pending:    e.coordinator.PendingPermissions,
			Loop:       []func(conversation.LoopStage, *session.State, *loop.Loop){e.sessions.ConversationPlanTools, e.sessions.ConversationScheduleTools, e.sessions.ConversationTracking},
			Input:      []func(context.Context, *conversation.Conversation, loop.Input, []model.Part, bool) ([]model.Part, error){e.sessions.ConversationInput},
			BeforeTurn: []func(context.Context, *conversation.Conversation) (func(loop.Outcome), error){func(ctx context.Context, c *conversation.Conversation) (func(loop.Outcome), error) {
				return e.execution.ConversationBudget(ctx, c)
			}},
			AfterTurn: []func(context.Context, *conversation.Conversation, event.ID, conversation.EndStage) error{func(ctx context.Context, c *conversation.Conversation, id event.ID, stage conversation.EndStage) error {
				return e.execution.ConversationRelease(ctx, c, id, stage)
			}, e.sessions.ConversationCheckpoint},
			Cancelled: []func(context.Context, event.ID){func(_ context.Context, id event.ID) {
				e.sessions.StopPlanOfCancelledTurn(id)
			}},
			Deleted: []func(context.Context, event.ID){e.sessions.DeleteConversationSnapshot},
		},
	})
	e.execution = execution.New(execution.Deps{
		Core: e.core, Registry: e.registry, Roster: e.roster, Conversation: e.conversation,
		Manager: manager, Groups: groups, Tasks: tasks, Catalog: catalog,
		Notes: notes, Gate: gate, Permissions: permissions, Dial: d.Dial,
		MCPCommand: d.MCPCommand, SandboxStateDir: d.Dirs.SandboxState, Temporary: d.Dirs.Temporary,
		AskPermission: askPermission, RunnerFor: runnerFor,
		RemoteCredentials: e.remote.RemoteCredentials, WorkerTools: e.coordinator.WorkerTools,
	})
	e.remote = remote.New(e.remote, remote.Deps{
		Core: e.core, Roster: e.roster, Execution: e.execution,
		Groups: groups, Tasks: tasks, Workspaces: e.workspaces,
		Permissions: permissions, Vault: vault, Dial: d.Dial, NewLink: d.NewLink,
		MCPCommand: d.MCPCommand, SandboxStateDir: d.Dirs.SandboxState,
		AskQuestion: askQuestion, RunnerFor: runnerFor, ApprovalTimedOut: e.coordinator.ApprovalTimedOut,
	})
	e.coordinator = coordinator.New(e.coordinator, coordinator.Deps{
		Core: e.core, Registry: e.registry, Conversation: e.conversation,
		Roster: e.roster, Execution: e.execution, Remote: e.remote,
		Catalog: catalog, Notes: notes, Manager: manager,
		Groups: groups, Tasks: tasks, Board: board, Workspaces: e.workspaces,
		Gate: gate, Permissions: permissions, AskQuestion: askQuestion, RunnerFor: runnerFor,
	})
	e.sessions = sessions.New(e.sessions, sessions.Deps{
		Core: e.core, Registry: e.registry, Conversation: e.conversation,
		Roster: e.roster, Remote: e.remote, Manager: manager,
		Notes: notes, Tools: tools, Gate: gate, Snapshots: d.Dirs.Snapshots,
	})
	e.project = project.New(e.project, project.Deps{
		Core: e.core, Registry: e.registry, Coordinator: e.coordinator, Terminals: e.terminals, Worktrees: d.Dirs.Worktrees,
		Review: review.Deps{
			Store:            e.core.Store,
			Session:          e.conversation.SessionSnapshot,
			Directory:        e.registry.Directory,
			Repo:             e.sessions.SnapshotRepo,
			SnapshotsEnabled: e.sessions.SnapshotsEnabled,
			External:         e.execution.HasExternalChat,
			Announce:         e.conversation.AnnounceReviewUpdate,
		},
	})
	e.adminDefinition = admindefinition.New(admindefinition.Deps{Core: e.core, Registry: e.registry, Groups: groups, Vault: vault})
	e.adminSkill = adminskill.New(adminskill.Deps{Registry: e.registry, Cache: d.Dirs.SkillCache})
	e.adminMCP = adminmcp.New(adminmcp.Deps{Core: e.core, Registry: e.registry})
	e.adminMemory = adminmemory.New(adminmemory.Deps{Registry: e.registry, Notes: notes})
	e.core.Workers.Go(func() { board.Run(e.core.Ctx, e.core.Logger) })
	e.core.Workers.Go(e.sessions.PruneDaily)
	e.conversation.SetLocalHuman("local-human")
	e.sessions.StartSchedules(d.ScheduleInterval)
	e.coordinator.WatchSentinel(d.SentinelInterval)
	return e, nil
}
