// Package coordinator runs groups, Leaders and collaboration workflows.
package coordinator

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

type Coordinator struct {
	core          *core.Core
	registry      *registry.Registry
	conversation  *conversation.Manager
	roster        *roster.Roster
	execution     *execution.Execution
	remote        *remote.Remote
	catalog       *catalog.Catalog
	notes         *memory.Repository
	manager       *session.Manager
	groups        *group.Manager
	tasks         *task.Pool
	board         *task.Board
	workspaces    *workspace.Manager
	gate          *permission.Gate
	permissions   *approval.Router
	askQuestion   func(context.Context, question.Request) (question.Answer, error)
	runnerFor     func(definition.Agent, *sandbox.Launcher) worker.Runner
	mu            sync.Mutex
	taskApprovals map[event.ID]*taskApproval
	merging       map[event.ID]bool
	groupRuns     map[event.ID]*groupRun
	sentinelSeen  map[string]bool
	sentinelMu    sync.Mutex
	inviteMu      sync.Mutex
	claimRestarts map[event.ID][]loop.Input
	// leaderStops holds the way to end the turn that a built-in Leader thread is running, by session.
	leaderStops map[event.ID]context.CancelFunc
}

func (c *Coordinator) Barrier() {
	c.mu.Lock()
	c.mu.Unlock()
}

// Deps supplies the shared objects used by group and Leader coordination.
type Deps struct {
	Core         *core.Core
	Registry     *registry.Registry
	Conversation *conversation.Manager
	Roster       *roster.Roster
	Execution    *execution.Execution
	Remote       *remote.Remote
	Catalog      *catalog.Catalog
	Notes        *memory.Repository
	Manager      *session.Manager
	Groups       *group.Manager
	Tasks        *task.Pool
	Board        *task.Board
	Workspaces   *workspace.Manager
	Gate         *permission.Gate
	Permissions  *approval.Router
	AskQuestion  func(context.Context, question.Request) (question.Answer, error)
	RunnerFor    func(definition.Agent, *sandbox.Launcher) worker.Runner
}

// New initializes the existing coordinator before its registered callbacks can run.
func New(target *Coordinator, d Deps) *Coordinator {
	target.sentinelSeen = make(map[string]bool)
	target.claimRestarts = make(map[event.ID][]loop.Input)
	target.leaderStops = make(map[event.ID]context.CancelFunc)
	target.taskApprovals = make(map[event.ID]*taskApproval)
	target.merging = make(map[event.ID]bool)
	target.groupRuns = make(map[event.ID]*groupRun)
	target.core = d.Core
	target.registry = d.Registry
	target.conversation = d.Conversation
	target.roster = d.Roster
	target.execution = d.Execution
	target.remote = d.Remote
	target.catalog = d.Catalog
	target.notes = d.Notes
	target.manager = d.Manager
	target.groups = d.Groups
	target.tasks = d.Tasks
	target.board = d.Board
	target.workspaces = d.Workspaces
	target.gate = d.Gate
	target.permissions = d.Permissions
	target.askQuestion = d.AskQuestion
	target.runnerFor = d.RunnerFor
	return target
}
