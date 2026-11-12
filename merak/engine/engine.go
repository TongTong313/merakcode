// Package engine assembles the conversation modules.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/clienttool"
	"github.com/TongTong313/merakcode/merak/engine/code"
	slash "github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/prompt"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/rules"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	memorystore "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/web"
	"github.com/TongTong313/merakcode/merak/engine/window"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/acp"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/engine/worker/codex"
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/engine/worker/opencode"
	"github.com/TongTong313/merakcode/merak/engine/worker/pi"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/cloud"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Deps struct {
	Cloud            cloud.Link
	SentinelInterval time.Duration
	// ScheduleInterval is how often due scheduled tasks are looked for; the default is one minute.
	ScheduleInterval time.Duration
	MCPCommand       string
	ApprovalTimeout  time.Duration
	DataDir          string
	// Vault keeps secrets; without one the engine uses the system vault under DataDir, or memory when it has no DataDir.
	Vault           credential.Vault
	SandboxStateDir string
	NetworkSettings NetworkSettings
	AskQuestion     func(context.Context, question.Request) (question.Answer, error)
	Logger          *slog.Logger
	MemoryIdle      time.Duration
	Store           store.Store
	Catalog         *catalog.Catalog
	Providers       map[string]model.Provider
	Model           string
	Thinking        model.Thinking
	Now             func() time.Time
	NewID           func() event.ID
	Workdir         string
	System          string
	ToolPool        string
	Deferred        []tool.Tool
	Ask             func(context.Context, permission.Request) (permission.Reply, error)
}

type Engine struct {
	agentMu           sync.Mutex
	remoteImportMu    sync.Mutex
	cloudHost         *deviceHost
	remoteHosts       map[string]*deviceHost
	memberMu          sync.Mutex
	memberExecutions  map[memberExecution]chan struct{}
	memberChanges     chan struct{}
	cloudLifecycle    sync.Mutex
	cloudMu           sync.Mutex
	cloudCancel       context.CancelFunc
	cloudDone         chan struct{}
	cloudLoops        chan struct{}
	cloudWorkCtx      context.Context
	cloudWorkCancel   context.CancelFunc
	cloudJobs         *sync.WaitGroup
	cloudCredentials  cloud.Credentials
	hostedGroups      sync.Map
	memoryExtractions sync.Map
	deviceRuns        map[event.ID]*deviceRun
	cloudReplies      map[event.ID]chan permission.Reply
	cloudAnswers      map[event.ID]*deviceAnswer
	remoteLookups     map[event.ID]chan tool.Result
	cloudReplyMu      sync.Mutex
	cloudPublishMu    sync.Mutex
	cloudWake         chan struct{}
	cloud             cloud.Link
	sentinelMu        sync.Mutex
	sentinelSeen      map[string]bool
	gate              *permission.Gate
	defaultModel      atomic.Pointer[agent.ModelRef]
	smallModel        atomic.Pointer[agent.ModelRef]
	agentSettings     atomic.Pointer[AgentSettings]
	memoryModel       atomic.Pointer[agent.ModelRef]
	catalogOnce       sync.Once
	vault             credential.Vault
	workspaceMu       sync.Mutex
	workspacePending  map[config.Trust]bool
	mcpCommand        string
	mcpProcesses      map[event.ID][]*mcp.Process
	taskApprovals     map[event.ID]*taskApproval
	permissions       *permission.Router
	dataDir           string
	sandboxMu         sync.Mutex
	networkMu         sync.RWMutex
	sandboxStateDir   string
	sandboxes         map[sandboxKey]*sandbox.Launcher
	sandboxErr        error
	launchGrants      map[launchGrant]permission.Decision
	networkSettings   NetworkSettings
	askPermission     func(context.Context, permission.Request) (permission.Reply, error)
	askQuestion       func(context.Context, question.Request) (question.Answer, error)
	workerQuestions   map[event.ID]*pendingWorkerQuestion
	Groups            *group.Manager
	Tasks             *task.Pool
	Board             *task.Board
	Workspaces        *workspace.Manager
	merging           map[event.ID]bool
	claimRuns         map[event.ID]claimRun
	claimPreparing    map[event.ID]*claimPreparation
	claimRestarts     map[event.ID][]loop.Input
	// leaderStops holds the way to end the turn that a built-in Leader thread is running, by session.
	leaderStops      map[event.ID]context.CancelFunc
	externals        map[event.ID]*externalChat
	inviteMu         sync.Mutex
	keyMu            sync.Mutex
	personal         atomic.Pointer[[]string]
	toolSwitches     atomic.Pointer[map[string]bool]
	plans            *plan.Plans
	commandSet       atomic.Pointer[map[string]slash.Entry]
	skillRoots       atomic.Pointer[skillRoots]
	memoryExtractOff atomic.Bool
	memoryRecallOff  atomic.Bool
	mcpLoginOnce     sync.Once
	mcpLoginSet      *mcp.Login
	snapshotMu       sync.Mutex
	worktreeOnce     sync.Once
	worktreeSet      *code.Worktrees
	snapshotDir      string
	snapshotTemp     bool
	snapshotsOff     atomic.Bool
	autoCompactOff   atomic.Bool
	retentionDays    atomic.Int64
	groupRuns        map[event.ID]*groupRun
	groupSessions    map[event.ID]bool
	runnerFor        func(agent.Agent, *sandbox.Launcher) worker.Runner
	Terminals        *terminal.Manager
	providersMu      sync.RWMutex
	logger           *slog.Logger
	notes            *memory.Repository
	memoryIdle       time.Duration
	Bus              *event.Bus
	providers        map[string]model.Provider
	model            string
	thinking         model.Thinking
	newID            func() event.ID
	workdir          string
	system           string
	now              func() time.Time
	tools            *tool.Pool
	clientTools      *clienttool.Registry
	schedules        schedule.Schedules
	scheduleRunner   *schedule.Runner
	scheduleNoticeMu sync.Mutex
	localHuman       event.ID
	store            store.Store
	manager          *session.Manager
	counter          *window.Counter
	catalog          *catalog.Catalog
	mu               sync.Mutex
	sessions         map[event.ID]*conversation
	ctx              context.Context
	cancel           context.CancelFunc
	workers          sync.WaitGroup
	shutdownOnce     sync.Once
	shutdownDone     chan struct{}
	shutdownErr      error
}

func New(d Deps) (*Engine, error) {
	if d.Cloud == nil {
		d.Cloud = cloud.Null{}
	}
	if d.SandboxStateDir == "" && d.DataDir != "" {
		d.SandboxStateDir = filepath.Join(d.DataDir, "sandbox")
	}
	if runtime.GOOS == "windows" && d.SandboxStateDir != "" {
		launcher := &sandbox.Launcher{StateDir: d.SandboxStateDir}
		launcher.Status(context.Background(), sandbox.Profile{})
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.NewID == nil {
		d.NewID = event.NewID
	}
	if d.Store == nil {
		d.Store = memorystore.New()
	}
	if d.ToolPool == "" {
		d.ToolPool = "worker.default"
	}
	if d.ToolPool != "worker.default" && d.ToolPool != "worker.readonly" {
		return nil, fmt.Errorf("unknown tool pool %q", d.ToolPool)
	}
	e := &Engine{
		memberChanges:   make(chan struct{}, 1),
		cloud:           d.Cloud,
		sentinelSeen:    make(map[string]bool),
		mcpCommand:      d.MCPCommand,
		dataDir:         d.DataDir,
		vault:           newVault(d.Vault, d.DataDir),
		sandboxStateDir: d.SandboxStateDir,
		sandboxes:       make(map[sandboxKey]*sandbox.Launcher),
		askQuestion:     d.AskQuestion,
		workerQuestions: make(map[event.ID]*pendingWorkerQuestion),
		claimPreparing:  make(map[event.ID]*claimPreparation),
		claimRestarts:   make(map[event.ID][]loop.Input),
		leaderStops:     make(map[event.ID]context.CancelFunc),
		externals:       make(map[event.ID]*externalChat),
		taskApprovals:   make(map[event.ID]*taskApproval),
		logger:          d.Logger,
		Bus:             event.NewBus(d.Store, d.Now, d.NewID), providers: make(map[string]model.Provider), newID: d.NewID, model: d.Model, thinking: d.Thinking,
		workdir: d.Workdir, system: d.System, now: d.Now, store: d.Store, tools: tool.NewPool(d.ToolPool),
	}
	e.Terminals = terminal.New(e.Bus, e.newID)
	e.networkSettings = d.NetworkSettings
	if e.networkSettings == nil {
		e.networkSettings = config.NewMemory()
	}
	e.ctx, e.cancel = context.WithCancel(context.Background())
	e.deviceRuns = make(map[event.ID]*deviceRun)
	e.cloudReplies = make(map[event.ID]chan permission.Reply)
	e.cloudAnswers = make(map[event.ID]*deviceAnswer)
	e.remoteLookups = make(map[event.ID]chan tool.Result)
	e.cloudWake = make(chan struct{}, 1)
	e.Bus.Route = e.deviceStream
	e.Groups = group.New(d.Store, e.Bus, e.newID)
	e.Tasks = task.New(d.Store, e.Bus, e.newID, e.Groups)
	e.Board = task.NewBoard(e.Tasks, e.Groups, d.Now)
	e.Tasks.AuthorizeAssignment = e.authorizeMemberAssignment
	e.permissions = &permission.Router{Bus: e.Bus, Groups: e.Groups, Tasks: e.Tasks, Human: d.Ask, Timeout: d.ApprovalTimeout}
	e.permissions.TimedOut = e.approvalTimedOut
	e.permissions.Remote = e.routeDevicePermission
	e.askQuestion = e.routeQuestion(d.AskQuestion)
	e.askPermission = e.permissions.Ask
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Router: e.permissions, Bus: e.Bus, Grants: permission.NewGrants(func() permission.Settings { return e.networkConfiguration() })}
	e.gate = gate
	e.runnerFor = func(p agent.Agent, launcher *sandbox.Launcher) worker.Runner {
		if p.Product != nil {
			switch p.Product.Kind {
			case worker.KindRemote:
				source := agent.RemoteSource{}
				if p.Product.Remote != nil {
					source = *p.Product.Remote
				}
				return &remote.Runner{Source: source, Bus: e.Bus, Store: e.store, Credentials: func(ctx context.Context) (protocol.RemoteConnectParams, error) {
					return e.remoteCredentials(ctx, source.Connection)
				}, Import: func(ctx context.Context, fact event.Event) error {
					return e.importRemoteEvent(ctx, source.Connection, fact)
				}, Reply: e.replyRemoteEvent}
			case worker.KindClaudeCode:
				return &claudecode.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Gate: gate, Product: *p.Product, System: p.System}
			case worker.KindCodex:
				return &codex.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Gate: gate, Product: *p.Product, System: p.System}
			case worker.KindOpenCode:
				return &opencode.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Gate: gate, Product: *p.Product, System: p.System}
			case worker.KindPi:
				return &pi.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Product: *p.Product, System: p.System}
			case worker.KindACP:
				return &acp.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Gate: gate, Product: *p.Product, System: p.System}
			case worker.KindCommand:
				return &command.Runner{Sandbox: launcher, Bus: e.Bus, Store: e.store, Product: *p.Product}
			}
		}
		return &builtin.Adapter{Bus: e.Bus, Execute: func(ctx context.Context, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
			return e.runAssignment(ctx, p, a, steer)
		}}
	}
	e.notes = memory.New(d.Store)
	e.memoryIdle = d.MemoryIdle
	if e.memoryIdle <= 0 {
		e.memoryIdle = 30 * time.Second
	}
	e.shutdownDone = make(chan struct{})
	e.manager = session.NewManager(d.Store, e.Bus)
	e.plans = plan.New(d.Store)
	e.Workspaces = workspace.New(e.ctx, d.Store, e.Bus, e.newID)
	e.merging = make(map[event.ID]bool)
	e.claimRuns = make(map[event.ID]claimRun)
	e.groupRuns = make(map[event.ID]*groupRun)
	e.groupSessions = make(map[event.ID]bool)
	e.counter = new(window.Counter)
	e.sessions = make(map[event.ID]*conversation)
	if d.Catalog == nil {
		d.Catalog = catalog.New()
	}
	e.catalog = d.Catalog
	for name, p := range d.Providers {
		e.providers[name] = &model.Retrying{Provider: e.blobs(p), Price: func(id string, u model.Usage) model.Usage { return e.catalog.Get(name, id).Price.Apply(u) }}
	}
	for _, t := range []tool.Tool{tool.Spawn{}, tool.WaitChild{}, tool.ReadFile{Memory: e.notes}, tool.Remember{Memory: e.notes}, tool.Recall{Memory: e.notes}, tool.WriteFile{}, tool.EditFile{}, tool.Bash{}, tool.Glob{}, tool.Grep{}, tool.ListDir{}, tool.Lookup{Store: d.Store}, tool.BashOutput{}, tool.TodoWrite{}, tool.WritePlan{}, tool.MultiEdit{}, tool.DocxRead{}, tool.ExcelRead{}, tool.ExcelWrite{}, web.Fetch{}, web.Search{}, web.Code{}} {
		if d.ToolPool == "worker.readonly" && t.Spec().Effect != tool.EffectRead {
			continue
		}
		e.tools.Tools[t.Spec().Name] = gate.Wrap(t)
	}
	e.tools.Deferred = make(map[string]tool.Tool)
	e.clientTools = clienttool.New()
	if d.ToolPool != "worker.readonly" {
		e.tools.Tools["ask_user"] = tool.AskUser{Bus: e.Bus, Ask: e.askQuestion}
	}
	for _, t := range d.Deferred {
		if d.ToolPool == "worker.readonly" && t.Spec().Effect != tool.EffectRead {
			continue
		}
		e.tools.Deferred[t.Spec().Name] = gate.Wrap(t)
		delete(e.tools.Tools, t.Spec().Name)
	}
	e.workers.Go(func() { e.Board.Run(e.ctx, e.logger) })
	e.workers.Go(e.pruneDaily)
	e.localHuman = "local-human"
	e.schedules = schedule.Schedules{Docs: e.store}
	e.scheduleRunner = &schedule.Runner{Schedules: e.schedules, Now: e.now, Fire: e.fireSchedule, Missed: e.missedSchedule}
	e.workers.Go(func() { e.watchSchedules(d.ScheduleInterval) })
	e.watchSentinel(d.SentinelInterval)
	return e, nil
}

func (e *Engine) Chat(ctx context.Context, provider, input string) (loop.Outcome, error) {
	c, err := e.newConversation(ctx, SessionOptions{Provider: provider})
	if err != nil {
		return loop.Outcome{}, err
	}
	defer e.releaseSandbox(c.state.ID)
	defer c.runner.Env.Jobs.Close()
	if c.children != nil {
		defer c.children.Close()
	}
	return e.runConversation(ctx, c, []model.Part{{Text: input}})
}

func (e *Engine) newConversation(ctx context.Context, options SessionOptions) (*conversation, error) {
	if err := config.ValidateMCPServers(options.MCPServers); err != nil {
		return nil, err
	}
	if err := options.Budget.Validate(); err != nil {
		return nil, err
	}
	if options.Mode != "" && options.Mode != permission.ModeAsk && options.Mode != permission.ModeAuto && options.Mode != permission.ModeTakeover {
		return nil, fmt.Errorf("MRK-4001")
	}
	options.Workdir = canonicalDirectory(options.Workdir)
	if options.Workdir == "" {
		options.Workdir = canonicalDirectory(e.workdir)
	}
	if err := workspace.Existing(options.Workdir); err != nil {
		return nil, coded(errorcode.WorkspaceInvalid, err)
	}
	if e.provider(options.Provider) == nil {
		return nil, fmt.Errorf("unknown provider %q", options.Provider)
	}
	if options.Model == "" {
		options.Model = e.model
	}
	if options.Thinking == "" {
		options.Thinking = e.thinking
	}
	system, describes, err := e.composeSystem(ctx, options)
	if err != nil {
		return nil, err
	}
	if options.ID == "" {
		options.ID = e.newID()
	}
	state := &session.State{ID: options.ID, Scope: options.Scope, System: system, Config: session.Config{Mode: options.Mode, Member: options.Member, ToolPool: options.ToolPool, Parent: options.Parent, Provider: options.Provider, Model: options.Model, Thinking: options.Thinking, Workdir: options.Workdir, Switches: options.Switches}}
	state.Config.Budget = options.Budget
	if options.Budget.MaxWallClock > 0 {
		state.Config.BudgetDeadline = e.now().Add(options.Budget.MaxWallClock)
	}
	state.BaseCommit, _ = git.Current(ctx, options.Workdir)
	state.Tools = e.sessionTools(state.Config).Specs()
	c, err := e.conversationFor(state)
	if err == nil && len(options.Tools) > 0 {
		keep := func(name string) bool { return slices.Contains(options.Tools, name) }
		for name := range c.runner.Tools.Tools {
			if !keep(name) {
				delete(c.runner.Tools.Tools, name)
			}
		}
		for name := range c.runner.Tools.Deferred {
			if !keep(name) {
				delete(c.runner.Tools.Deferred, name)
			}
		}
		c.state.Tools = c.runner.Tools.Specs()
	}
	if err == nil && describes {
		c.state.Tools = c.runner.Tools.Specs()
	}
	if err == nil && len(options.MCPServers) > 0 {
		body, _ := json.Marshal(options.MCPServers)
		_ = json.Unmarshal(body, &c.mcpServers)
	}
	return c, err
}

// composeSystem builds the system prompt of a conversation in a folder: the product prompt, the user's and the
// project's rules, and the skills. A folder that is gone has neither rules nor skills. describes says that the rules
// or skills carry descriptions the model loads tools for.
func (e *Engine) composeSystem(ctx context.Context, options SessionOptions) (system string, describes bool, err error) {
	situation := prompt.Situation{
		Role:   options.Role,
		System: e.system + "\n" + options.System, Environment: prompt.Environment{OS: runtime.GOOS, Shell: "bash", Workdir: options.Workdir},
		Deferred: e.sessionTools(session.Config{Parent: options.Parent, ToolPool: options.ToolPool, Switches: options.Switches}).DeferredSpecs(),
	}
	situation.Personal = e.personalRules()
	if workspace.Existing(options.Workdir) == nil {
		projectRules, err := rules.Load(ctx, options.Workdir)
		if err != nil {
			return "", false, err
		}
		skills, err := e.skills(options.Workdir)
		if err != nil {
			return "", false, err
		}
		describes = projectRules.HasDescribed() || options.Parent == "" && len(skills.Skills) > 0
		if options.Parent == "" {
			situation.Skills = skills.Section()
		}
		situation.Instructions = projectRules.Sections(nil)
	}
	if options.Parent != "" {
		situation.Deferred = e.sessionTools(session.Config{Parent: options.Parent, Switches: options.Switches}).DeferredSpecs()
		situation.System += "\nYou are a read-only child. Research the assigned question and return a concise report. You cannot modify files, claim tasks or start children."
	}
	return (prompt.Composer{}).System(situation), describes, nil
}

func (e *Engine) conversationFor(state *session.State) (*conversation, error) {
	p := e.provider(state.Config.Provider)
	if p == nil {
		return nil, fmt.Errorf("unknown provider %q", state.Config.Provider)
	}
	runner := loop.Loop{Model: p, ModelID: state.Config.Model, Thinking: state.Config.Thinking, Bus: e.Bus, Tools: e.sessionTools(state.Config), Env: tool.Env{Member: state.Config.Member, Mode: string(state.Config.Mode), Workdir: state.Config.Workdir, Reads: new(tool.Reads), Jobs: new(tool.Jobs), Spill: e.spill}}
	runner.Limits = state.Config.Budget
	launcher := &sandbox.Launcher{StateDir: e.sandboxStateDir, Disabled: state.Config.Mode == permission.ModeTakeover, Reclaimable: state.Scope.Group == ""}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	configuration, err := e.memberSandboxProfile(e.ctx, state.Config.Workdir, sandbox.Profile{Network: sandbox.Network{Mode: "allowlist"}})
	if err != nil {
		return nil, err
	}
	configuration, err = denyProductState(configuration)
	if err != nil {
		return nil, err
	}
	runner.Env.Sandbox = launcher
	runner.Env.SandboxProfile = configuration
	memberAgent := agent.DefaultWorker()
	if state.Scope.Group != "" && state.Config.Member != "" {
		groupID, memberID := e.executionSource(state.Scope, state.Config.Member)
		member, err := e.groupMember(e.ctx, groupID, memberID)
		if err != nil {
			return nil, err
		}
		memberAgent, err = e.memberAgent(e.ctx, member)
		if err != nil {
			return nil, err
		}
	}
	assignment := worker.Assignment{Session: state.ID, Scope: state.Scope, Workdir: state.Config.Workdir, Claim: task.Claim{Member: state.Config.Member}, SandboxProfile: configuration}
	network, err := e.workerNetworkPolicy(e.ctx, memberAgent, assignment)
	if err != nil {
		return nil, err
	}
	runner.Env.SandboxProfile.Network = network
	e.connectSandboxNetwork(launcher, memberAgent, assignment)
	runner.Env.Sandbox = e.keepSandbox(state.ID, launcher)
	runner.Env.MemoryOwners = e.memberMemoryOwners(e.ctx, state.Config.Workdir, state.Scope, state.Config.Member)
	runner.Env.Spill = func(ctx context.Context, name string, body []byte) (tool.Ref, error) {
		return e.spillScoped(ctx, state.Scope, name, body)
	}
	if state.Config.Parent == "" {
		if skills, err := e.skills(state.Config.Workdir); err == nil && len(skills.Skills) > 0 {
			runner.Tools = runner.Tools.With(tool.Skill{Read: skills.Read})
		}
		if set, err := rules.Load(e.ctx, state.Config.Workdir); err == nil {
			runner.Env.Attach = set.Attacher(state.Config.Workdir)
			if set.HasDescribed() {
				runner.Tools = runner.Tools.With(tool.Rule{Lookup: set.Lookup})
			}
		}
	}
	if state.Config.Parent == "" && state.Config.ToolPool != "leader.default" {
		planned := new(atomic.Bool)
		runner.Tools = runner.Tools.With(tool.WritePlan{Write: func(ctx context.Context, content string) error {
			if _, err := e.writePlan(ctx, state.ID, content); err != nil {
				return err
			}
			planned.Store(true)
			return nil
		}})
		runner.Finish = func() []model.Part {
			if planned.CompareAndSwap(true, false) {
				return []model.Part{{Text: "The plan is ready for review."}}
			}
			return nil
		}
		runner.OnTodos = func(ctx context.Context, items []tool.Todo) { e.todosChanged(ctx, state.ID, items) }
	}
	if state.Config.Parent == "" && state.Scope.Group == "" {
		scheduler := sessionScheduler{e: e, workdir: state.Config.Workdir}
		for _, t := range []tool.Tool{tool.ScheduleCreate{Scheduler: scheduler}, tool.ScheduleList{Scheduler: scheduler}, tool.ScheduleDelete{Scheduler: scheduler}} {
			readOnly := state.Config.ToolPool == "worker.readonly" || e.tools.Name == "worker.readonly"
			if name := t.Spec().Name; e.toolEnabled(name) && switchedOn(state.Config.Switches, name) && (!readOnly || t.Spec().Effect == tool.EffectRead) {
				runner.Tools = runner.Tools.With(e.gate.Wrap(t))
			}
		}
	}
	runner.Tools.RestoreLoaded(state.Loaded)
	runner.Snapshot = e.manager.Snapshot
	runner.Track = e.trackWorkspace(state.ID, state.Config.Workdir)
	entry := e.catalog.Get(state.Config.Provider, state.Config.Model)
	reserve := max(entry.MaxOutput/4, 8192)
	runner.Window = &window.Builder{Budget: window.Budget{Window: entry.Window, Reserve: reserve, Trigger: .9, Target: .6, KeepTurns: 4, ResultCap: 50 * 1024}, Counter: e.counter, Bus: e.Bus, Summarize: e.summarizer(p)}
	runner.Window.Snapshot = e.manager.Snapshot
	c := &conversation{state: state, runner: runner, queue: make(chan *conversationTurn, 1), turns: make(map[*conversationTurn]struct{})}
	if state.Config.Parent == "" && state.Scope.Group == "" {
		if skills, err := e.skills(state.Config.Workdir); err == nil {
			c.recommender = skills.Recommender()
		}
	}
	if state.Config.Parent == "" {
		c.children = builtin.New(e.ctx, e.Bus, e.newID, e.childRun(state.ID, state.Scope, state.Config))
		c.runner.Env.Children = c.children
		c.runner.Steer = c.children
	}
	return c, nil
}

func (e *Engine) childRun(parent event.ID, scope event.Scope, config session.Config) func(context.Context, event.ID, string) (loop.Outcome, error) {
	return func(ctx context.Context, id event.ID, input string) (loop.Outcome, error) {
		childScope := event.Scope{Group: scope.Group, Task: scope.Task, Session: id}
		options := SessionOptions{ID: id, Parent: parent, Scope: childScope, Member: config.Member, Mode: config.Mode, Provider: config.Provider, Model: config.Model, Thinking: config.Thinking, Workdir: config.Workdir, Budget: config.Budget}
		if name := builtin.AgentOf(ctx); name != "" {
			found, ok := e.agentNamed(name, config.Workdir)
			if !ok {
				return loop.Outcome{}, coded(errorcode.SessionRequestFailed, fmt.Errorf("no agent is named %s", name))
			}
			options.System = found.System
			if found.Model.Provider != "" && found.Model.Model != "" {
				options.Provider, options.Model, options.Thinking = found.Model.Provider, found.Model.Model, found.Model.Thinking
			}
			options.Tools, options.Switches = found.Tools, found.Switches
		}
		child, err := e.newConversation(ctx, options)
		if err != nil {
			return loop.Outcome{}, err
		}
		defer e.releaseSandbox(child.state.ID)
		defer child.runner.Env.Jobs.Close()
		child.state, err = e.manager.Create(ctx, *child.state)
		if err != nil {
			return loop.Outcome{}, err
		}
		return e.runConversation(ctx, child, []model.Part{{Text: input}})
	}
}

func (e *Engine) sessionTools(config session.Config) *tool.Pool {
	pool := e.tools.With()
	for _, t := range e.clientTools.Tools() {
		pool.Deferred[t.Spec().Name] = e.gate.Wrap(t)
	}
	enabled := func(name string) bool { return e.toolEnabled(name) && switchedOn(config.Switches, name) }
	for name := range pool.Tools {
		if !enabled(name) {
			delete(pool.Tools, name)
		}
	}
	for name := range pool.Deferred {
		if !enabled(name) {
			delete(pool.Deferred, name)
		}
	}
	if config.Parent == "" && config.ToolPool != "worker.readonly" && config.ToolPool != "leader.default" {
		return pool
	}
	pool.Name = config.ToolPool
	if pool.Name == "" {
		pool.Name = "worker.readonly"
	}
	for name, t := range pool.Tools {
		if t.Spec().Effect != tool.EffectRead || config.Parent != "" && (name == "spawn" || name == "wait_child" || name == "write_plan") {
			delete(pool.Tools, name)
		}
	}
	for name, t := range pool.Deferred {
		if t.Spec().Effect != tool.EffectRead {
			delete(pool.Deferred, name)
		}
	}
	return pool
}

func (e *Engine) spill(ctx context.Context, name string, body []byte) (tool.Ref, error) {
	return e.spillScoped(ctx, event.Scope{}, name, body)
}

func (e *Engine) spillScoped(ctx context.Context, scope event.Scope, name string, body []byte) (tool.Ref, error) {
	id := string(e.newID())
	if err := e.store.Put(ctx, store.Doc{Kind: "blob", Key: id, Body: body, Meta: map[string]string{"title": name, "group": string(scope.Group), "session": string(scope.Session)}}); err != nil {
		return "", err
	}
	return tool.Ref("mrk://blob/" + id), nil
}

func newVault(given credential.Vault, dataDir string) credential.Vault {
	switch {
	case given != nil:
		return given
	case dataDir != "" && os.Getenv("MERAKCODE_FILE_CREDENTIALS") == "1":
		// For machines without a system vault, and for tests: private files under the data directory.
		return credential.NewFile(filepath.Join(dataDir, "credentials"))
	case dataDir != "":
		return credential.New(filepath.Join(dataDir, "credentials"))
	}
	return credential.NewMemory()
}

// Vault returns the vault of the engine, for the server that hosts it.
func (e *Engine) Vault() credential.Vault { return e.vault }
