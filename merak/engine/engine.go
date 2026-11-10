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
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/prompt"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	memorystore "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/engine/tool"
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
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Deps struct {
	Cloud            cloud.Link
	SentinelInterval time.Duration
	MCPCommand       string
	ApprovalTimeout  time.Duration
	DataDir          string
	SandboxStateDir  string
	NetworkSettings  NetworkSettings
	AskQuestion      func(context.Context, question.Request) (question.Answer, error)
	Logger           *slog.Logger
	MemoryIdle       time.Duration
	Store            store.Store
	Catalog          *catalog.Catalog
	Providers        map[string]model.Provider
	Model            string
	Thinking         model.Thinking
	Now              func() time.Time
	NewID            func() event.ID
	Workdir          string
	System           string
	ToolPool         string
	Deferred         []tool.Tool
	Ask              func(context.Context, permission.Request) (permission.Reply, error)
}

type Engine struct {
	profileMu         sync.Mutex
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
	Workspaces        *workspace.Manager
	merging           map[event.ID]bool
	claimRuns         map[event.ID]claimRun
	claimPreparing    map[event.ID]*claimPreparation
	groupRuns         map[event.ID]*groupRun
	groupSessions     map[event.ID]bool
	runnerFor         func(profile.Profile, *sandbox.Launcher) worker.Runner
	Terminals         *terminal.Manager
	providersMu       sync.RWMutex
	logger            *slog.Logger
	notes             *memory.Repository
	memoryIdle        time.Duration
	Bus               *event.Bus
	providers         map[string]model.Provider
	model             string
	thinking          model.Thinking
	newID             func() event.ID
	workdir           string
	system            string
	now               func() time.Time
	tools             *tool.Pool
	store             store.Store
	manager           *session.Manager
	counter           *window.Counter
	catalog           *catalog.Catalog
	mu                sync.Mutex
	sessions          map[event.ID]*conversation
	ctx               context.Context
	cancel            context.CancelFunc
	workers           sync.WaitGroup
	shutdownOnce      sync.Once
	shutdownDone      chan struct{}
	shutdownErr       error
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
		sandboxStateDir: d.SandboxStateDir,
		sandboxes:       make(map[sandboxKey]*sandbox.Launcher),
		askQuestion:     d.AskQuestion,
		workerQuestions: make(map[event.ID]*pendingWorkerQuestion),
		claimPreparing:  make(map[event.ID]*claimPreparation),
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
	e.Tasks.AuthorizeAssignment = e.authorizeMemberAssignment
	e.permissions = &permission.Router{Bus: e.Bus, Groups: e.Groups, Tasks: e.Tasks, Human: d.Ask, Timeout: d.ApprovalTimeout}
	e.permissions.TimedOut = e.approvalTimedOut
	e.permissions.Remote = e.routeDevicePermission
	e.askQuestion = e.routeQuestion(d.AskQuestion)
	e.askPermission = e.permissions.Ask
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Router: e.permissions, Bus: e.Bus, Grants: permission.NewGrants(func() permission.Settings { return e.networkConfiguration() })}
	e.gate = gate
	e.runnerFor = func(p profile.Profile, launcher *sandbox.Launcher) worker.Runner {
		if p.Product != nil {
			switch p.Product.Kind {
			case worker.KindRemote:
				source := profile.RemoteSource{}
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
	e.Workspaces = workspace.New(e.ctx, d.Store, e.Bus, e.newID)
	e.merging = make(map[event.ID]bool)
	e.claimRuns = make(map[event.ID]claimRun)
	e.groupRuns = make(map[event.ID]*groupRun)
	e.groupSessions = make(map[event.ID]bool)
	e.counter = new(window.Counter)
	e.sessions = make(map[event.ID]*conversation)
	e.watchStorage()
	if d.Catalog == nil {
		d.Catalog = catalog.New()
	}
	e.catalog = d.Catalog
	for name, p := range d.Providers {
		e.providers[name] = &model.Retrying{Provider: p, Price: func(id string, u model.Usage) model.Usage { return e.catalog.Get(name, id).Price.Apply(u) }}
	}
	for _, t := range []tool.Tool{tool.Spawn{}, tool.WaitChild{}, tool.ReadFile{Memory: e.notes}, tool.Remember{Memory: e.notes}, tool.Recall{Memory: e.notes}, tool.WriteFile{}, tool.EditFile{}, tool.Bash{}, tool.Glob{}, tool.Grep{}, tool.ListDir{}, tool.Lookup{Store: d.Store}, tool.BashOutput{}} {
		if d.ToolPool == "worker.readonly" && t.Spec().Effect != tool.EffectRead {
			continue
		}
		e.tools.Tools[t.Spec().Name] = gate.Wrap(t)
	}
	e.tools.Deferred = make(map[string]tool.Tool)
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
	if e.provider(options.Provider) == nil {
		return nil, fmt.Errorf("unknown provider %q", options.Provider)
	}
	if options.Workdir == "" {
		options.Workdir = e.workdir
	}
	if options.Model == "" {
		options.Model = e.model
	}
	if options.Thinking == "" {
		options.Thinking = e.thinking
	}
	situation := prompt.Situation{
		Role:   options.Role,
		System: e.system + "\n" + options.System, Environment: prompt.Environment{OS: runtime.GOOS, Shell: "bash", Workdir: options.Workdir},
		Deferred: e.sessionTools(session.Config{Parent: options.Parent, ToolPool: options.ToolPool}).DeferredSpecs(),
	}
	rules, err := os.ReadFile(filepath.Join(options.Workdir, "AGENTS.md"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(rules) > 0 {
		situation.Instructions = []string{string(rules)}
	}
	if options.Parent != "" {
		situation.Deferred = e.sessionTools(session.Config{Parent: options.Parent}).DeferredSpecs()
		situation.System += "\nYou are a read-only child. Research the assigned question and return a concise report. You cannot modify files, claim tasks or start children."
	}
	if options.ID == "" {
		options.ID = e.newID()
	}
	state := &session.State{ID: options.ID, Scope: options.Scope, System: (prompt.Composer{}).System(situation), Config: session.Config{Mode: options.Mode, Member: options.Member, ToolPool: options.ToolPool, Parent: options.Parent, Provider: options.Provider, Model: options.Model, Thinking: options.Thinking, Workdir: options.Workdir}}
	state.Config.Budget = options.Budget
	if options.Budget.MaxWallClock > 0 {
		state.Config.BudgetDeadline = e.now().Add(options.Budget.MaxWallClock)
	}
	state.BaseCommit, _ = git.Current(ctx, options.Workdir)
	state.Tools = e.sessionTools(state.Config).Specs()
	c, err := e.conversationFor(state)
	if err == nil && len(options.MCPServers) > 0 {
		body, _ := json.Marshal(options.MCPServers)
		_ = json.Unmarshal(body, &c.mcpServers)
	}
	return c, err
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
	memberProfile := profile.DefaultWorker()
	if state.Scope.Group != "" && state.Config.Member != "" {
		groupID, memberID := e.executionSource(state.Scope, state.Config.Member)
		member, err := e.groupMember(e.ctx, groupID, memberID)
		if err != nil {
			return nil, err
		}
		memberProfile, err = e.memberProfile(e.ctx, member)
		if err != nil {
			return nil, err
		}
	}
	assignment := worker.Assignment{Session: state.ID, Scope: state.Scope, Workdir: state.Config.Workdir, Claim: task.Claim{Member: state.Config.Member}, SandboxProfile: configuration}
	network, err := e.workerNetworkPolicy(e.ctx, memberProfile, assignment)
	if err != nil {
		return nil, err
	}
	runner.Env.SandboxProfile.Network = network
	e.connectSandboxNetwork(launcher, memberProfile, assignment)
	runner.Env.Sandbox = e.keepSandbox(state.ID, launcher)
	runner.Env.MemoryOwners = e.memberMemoryOwners(e.ctx, state.Config.Workdir, state.Scope, state.Config.Member)
	runner.Env.Spill = func(ctx context.Context, name string, body []byte) (tool.Ref, error) {
		return e.spillScoped(ctx, state.Scope, name, body)
	}
	runner.Tools.RestoreLoaded(state.Loaded)
	runner.Snapshot = e.manager.Snapshot
	entry := e.catalog.Get(state.Config.Provider, state.Config.Model)
	reserve := max(entry.MaxOutput/4, 8192)
	runner.Window = &window.Builder{Budget: window.Budget{Window: entry.Window, Reserve: reserve, Trigger: .9, Target: .6, KeepTurns: 4, ResultCap: 50 * 1024}, Counter: e.counter, Bus: e.Bus, Summarize: window.ModelSummarizer{Provider: p}}
	runner.Window.Snapshot = e.manager.Snapshot
	c := &conversation{state: state, runner: runner, queue: make(chan *conversationTurn, 1), turns: make(map[*conversationTurn]struct{})}
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
		child, err := e.newConversation(ctx, SessionOptions{ID: id, Parent: parent, Scope: childScope, Member: config.Member, Mode: config.Mode, Provider: config.Provider, Model: config.Model, Thinking: config.Thinking, Workdir: config.Workdir, Budget: config.Budget})
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
	if config.Parent == "" && config.ToolPool != "worker.readonly" && config.ToolPool != "leader.default" {
		return pool
	}
	pool.Name = config.ToolPool
	if pool.Name == "" {
		pool.Name = "worker.readonly"
	}
	for name, t := range pool.Tools {
		if t.Spec().Effect != tool.EffectRead || config.Parent != "" && (name == "spawn" || name == "wait_child") {
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
