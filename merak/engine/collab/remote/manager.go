// Package remote coordinates cloud links, remote members and device work.
package remote

import (
	"context"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/approval"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

// Remote owns remote connections, device work and pending member questions.
type Remote struct {
	core             *core.Core
	roster           *roster.Roster
	execution        *execution.Execution
	groups           *group.Manager
	tasks            *task.Pool
	workspaces       *workspace.Manager
	permissions      *approval.Router
	vault            credential.Vault
	dial             wire.Dial
	newLink          func() wire.Link
	mcpCommand       string
	sandboxStateDir  string
	askQuestion      func(context.Context, question.Request) (question.Answer, error)
	runnerFor        func(definition.Agent, *sandbox.Launcher) worker.Runner
	approvalTimedOut func(context.Context, event.Scope, event.ID, event.ID)
	mu               sync.Mutex
	workerQuestions  map[event.ID]*PendingWorkerQuestion
	cloudMu          sync.Mutex
	cloudHost        *deviceHost
	remoteLookups    map[event.ID]chan tool.Result
	remoteImportMu   sync.Mutex
	remoteHosts      map[string]*deviceHost
	deviceRuns       map[event.ID]*deviceRun
	cloudWorkCtx     context.Context
	cloudWorkCancel  context.CancelFunc
	cloudWake        chan struct{}
	cloudReplyMu     sync.Mutex
	cloudReplies     map[event.ID]chan permission.Reply
	cloudPublishMu   sync.Mutex
	cloudLoops       chan struct{}
	cloudLifecycle   sync.Mutex
	cloudJobs        *sync.WaitGroup
	cloudDone        chan struct{}
	cloudCredentials wire.Credentials
	cloudCancel      context.CancelFunc
	cloudAnswers     map[event.ID]*deviceAnswer
	cloud            wire.Link
}

// Deps supplies remote services and the existing higher-level callbacks.
type Deps struct {
	Core             *core.Core
	Roster           *roster.Roster
	Execution        *execution.Execution
	Groups           *group.Manager
	Tasks            *task.Pool
	Workspaces       *workspace.Manager
	Permissions      *approval.Router
	Vault            credential.Vault
	Dial             wire.Dial
	NewLink          func() wire.Link
	MCPCommand       string
	SandboxStateDir  string
	AskQuestion      func(context.Context, question.Request) (question.Answer, error)
	RunnerFor        func(definition.Agent, *sandbox.Launcher) worker.Runner
	ApprovalTimedOut func(context.Context, event.Scope, event.ID, event.ID)
}

// New initializes target once, before the engine starts its background work.
// Keeping target preserves the method values captured while assembling its dependencies.
func New(target *Remote, d Deps) *Remote {
	target.cloud = wire.Null{}
	target.workerQuestions = make(map[event.ID]*PendingWorkerQuestion)
	target.deviceRuns = make(map[event.ID]*deviceRun)
	target.cloudReplies = make(map[event.ID]chan permission.Reply)
	target.cloudAnswers = make(map[event.ID]*deviceAnswer)
	target.remoteLookups = make(map[event.ID]chan tool.Result)
	target.cloudWake = make(chan struct{}, 1)
	target.core = d.Core
	target.roster = d.Roster
	target.execution = d.Execution
	target.groups = d.Groups
	target.tasks = d.Tasks
	target.workspaces = d.Workspaces
	target.permissions = d.Permissions
	target.vault = d.Vault
	target.dial = d.Dial
	target.newLink = d.NewLink
	target.mcpCommand = d.MCPCommand
	target.sandboxStateDir = d.SandboxStateDir
	target.askQuestion = d.AskQuestion
	target.runnerFor = d.RunnerFor
	target.approvalTimedOut = d.ApprovalTimedOut
	return target
}
