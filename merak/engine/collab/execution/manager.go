// Package execution runs group members and owns their sandbox and claim state.
package execution

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

// Deps supplies execution services and higher-level callbacks.
type Deps struct {
	Core              *core.Core
	Registry          *registry.Registry
	Roster            *roster.Roster
	Conversation      *conversation.Manager
	Manager           *session.Manager
	Groups            *group.Manager
	Tasks             *task.Pool
	Catalog           *catalog.Catalog
	Notes             *memory.Repository
	Gate              *permission.Gate
	Permissions       *approval.Router
	Dial              wire.Dial
	MCPCommand        string
	SandboxStateDir   string
	Temporary         string
	AskPermission     func(context.Context, permission.Request) (permission.Reply, error)
	RunnerFor         func(definition.Agent, *sandbox.Launcher) worker.Runner
	RemoteCredentials func(context.Context, event.ID) (wire.RemoteConnectParams, error)
	WorkerTools       func(worker.Assignment, func(context.Context, task.Report) error) []tool.Tool
}

// Execution owns member runs, external conversations, claims, and sandboxes.
type Execution struct {
	core              *core.Core
	registry          *registry.Registry
	roster            *roster.Roster
	conversation      *conversation.Manager
	manager           *session.Manager
	groups            *group.Manager
	tasks             *task.Pool
	catalog           *catalog.Catalog
	notes             *memory.Repository
	gate              *permission.Gate
	permissions       *approval.Router
	dial              wire.Dial
	mcpCommand        string
	sandboxStateDir   string
	temporary         string
	askPermission     func(context.Context, permission.Request) (permission.Reply, error)
	runnerFor         func(definition.Agent, *sandbox.Launcher) worker.Runner
	remoteCredentials func(context.Context, event.ID) (wire.RemoteConnectParams, error)
	workerTools       func(worker.Assignment, func(context.Context, task.Report) error) []tool.Tool
	mu                sync.Mutex
	sandboxMu         sync.Mutex
	memberMu          sync.Mutex
	memberExecutions  map[memberExecution]chan struct{}
	memberChanges     chan struct{}
	claimRuns         map[event.ID]ClaimRun
	claimPreparing    map[event.ID]*claimPreparation
	groupSessions     map[event.ID]bool
	sandboxes         map[sandboxKey]*sandbox.Launcher
	sandboxErr        error
	launchGrants      map[launchGrant]permission.Decision
	externals         map[event.ID]*externalChat
}

// New prepares execution state before the engine starts its background work.
func New(d Deps) *Execution {
	return &Execution{
		core: d.Core, registry: d.Registry, roster: d.Roster, conversation: d.Conversation,
		manager: d.Manager, groups: d.Groups, tasks: d.Tasks, catalog: d.Catalog,
		notes: d.Notes, gate: d.Gate, permissions: d.Permissions, dial: d.Dial,
		mcpCommand: d.MCPCommand, sandboxStateDir: d.SandboxStateDir, temporary: d.Temporary,
		askPermission: d.AskPermission, runnerFor: d.RunnerFor,
		remoteCredentials: d.RemoteCredentials, workerTools: d.WorkerTools,
		memberChanges:  make(chan struct{}, 1),
		sandboxes:      make(map[sandboxKey]*sandbox.Launcher),
		claimPreparing: make(map[event.ID]*claimPreparation),
		externals:      make(map[event.ID]*externalChat),
		claimRuns:      make(map[event.ID]ClaimRun),
		groupSessions:  make(map[event.ID]bool),
	}
}
