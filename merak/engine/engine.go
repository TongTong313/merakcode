// Package engine assembles the conversation modules.
package engine

import (
	"context"
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
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Deps struct {
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
	launchGrants    map[launchGrant]permission.Decision
	networkSettings NetworkSettings
	askPermission   func(context.Context, permission.Request) (permission.Reply, error)
	askQuestion     func(context.Context, question.Request) (question.Answer, error)
	workerQuestions map[event.ID]*pendingWorkerQuestion
	Groups          *group.Manager
	Tasks           *task.Pool
	Workspaces      *workspace.Manager
	merging         map[event.ID]bool
	claimRuns       map[event.ID]claimRun
	groupRuns       map[event.ID]*groupRun
	groupSessions   map[event.ID]bool
	runnerFor       func(profile.Profile, *sandbox.Launcher) worker.Runner
	Terminals       *terminal.Manager
	providersMu     sync.RWMutex
	logger          *slog.Logger
	notes           *memory.Repository
	memoryIdle      time.Duration
	Bus             *event.Bus
	providers       map[string]model.Provider
	model           string
	thinking        model.Thinking
	newID           func() event.ID
	workdir         string
	system          string
	now             func() time.Time
	tools           *tool.Pool
	store           store.Store
	manager         *session.Manager
	counter         *window.Counter
	catalog         *catalog.Catalog
	mu              sync.Mutex
	sessions        map[event.ID]*conversation
	ctx             context.Context
	cancel          context.CancelFunc
	workers         sync.WaitGroup
	shutdownOnce    sync.Once
	shutdownDone    chan struct{}
	shutdownErr     error
}

func New(d Deps) (*Engine, error) {
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
		askQuestion:     d.AskQuestion,
		workerQuestions: make(map[event.ID]*pendingWorkerQuestion),
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
	e.askQuestion = e.routeQuestion(d.AskQuestion)
	e.askPermission = e.routePermission(d.Ask)
	gate := &permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Ask: e.askPermission, Bus: e.Bus}
	e.runnerFor = func(p profile.Profile, launcher *sandbox.Launcher) worker.Runner {
		if p.Product != nil {
			switch p.Product.Kind {
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
	e.Groups = group.New(d.Store, e.Bus, e.newID)
	e.Tasks = task.New(d.Store, e.Bus, e.newID, e.Groups)
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
	return e, nil
}

func (e *Engine) Chat(ctx context.Context, provider, input string) (loop.Outcome, error) {
	c, err := e.newConversation(ctx, SessionOptions{Provider: provider})
	if err != nil {
		return loop.Outcome{}, err
	}
	defer c.runner.Env.Jobs.Close()
	if c.children != nil {
		defer c.children.Close()
	}
	return e.runConversation(ctx, c, []model.Part{{Text: input}})
}

func (e *Engine) newConversation(ctx context.Context, options SessionOptions) (*conversation, error) {
	if options.Mode != "" && options.Mode != permission.ModeAsk && options.Mode != permission.ModeTakeover {
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
	state.BaseCommit, _ = git.Current(ctx, options.Workdir)
	state.Tools = e.sessionTools(state.Config).Specs()
	return e.conversationFor(state)
}

func (e *Engine) conversationFor(state *session.State) (*conversation, error) {
	p := e.provider(state.Config.Provider)
	if p == nil {
		return nil, fmt.Errorf("unknown provider %q", state.Config.Provider)
	}
	runner := loop.Loop{Model: p, ModelID: state.Config.Model, Thinking: state.Config.Thinking, Bus: e.Bus, Tools: e.sessionTools(state.Config), Env: tool.Env{Mode: string(state.Config.Mode), Workdir: state.Config.Workdir, Reads: new(tool.Reads), Jobs: new(tool.Jobs), Spill: e.spill}}
	launcher := &sandbox.Launcher{Disabled: state.Config.Mode == permission.ModeTakeover}
	if launcher.Disabled || launcher.Status(e.ctx, sandbox.Profile{}).Available {
		configuration, err := memberSandboxProfile(e.ctx, state.Config.Workdir, sandbox.Profile{Network: sandbox.Network{Mode: "allowlist"}})
		if err != nil {
			return nil, err
		}
		runner.Env.Sandbox = launcher
		runner.Env.SandboxProfile = configuration
		memberProfile := profile.DefaultWorker()
		if state.Scope.Group != "" && state.Config.Member != "" {
			member, err := e.groupMember(e.ctx, state.Scope.Group, state.Config.Member)
			if err != nil {
				return nil, err
			}
			memberProfile, err = e.memberProfile(e.ctx, member)
			if err != nil {
				return nil, err
			}
		}
		e.connectSandboxNetwork(launcher, memberProfile, worker.Assignment{Session: state.ID, Scope: state.Scope, Workdir: state.Config.Workdir, Claim: task.Claim{Member: state.Config.Member}})
	}
	runner.Env.MemoryOwners = []memory.Owner{memory.ProjectOwner(state.Config.Workdir)}
	runner.Tools.RestoreLoaded(state.Loaded)
	runner.Snapshot = e.manager.Snapshot
	entry := e.catalog.Get(state.Config.Provider, state.Config.Model)
	reserve := max(entry.MaxOutput/4, 8192)
	runner.Window = &window.Builder{Budget: window.Budget{Window: entry.Window, Reserve: reserve, Trigger: .9, Target: .6, KeepTurns: 4, ResultCap: 50 * 1024}, Counter: e.counter, Bus: e.Bus, Summarize: window.ModelSummarizer{Provider: p}}
	runner.Window.Snapshot = e.manager.Snapshot
	c := &conversation{state: state, runner: runner, queue: make(chan *conversationTurn, 1), turns: make(map[*conversationTurn]struct{})}
	if state.Config.Parent == "" {
		c.children = builtin.New(e.ctx, e.Bus, e.newID, e.childRun(state.ID, state.Config))
		c.runner.Env.Children = c.children
		c.runner.Steer = c.children
	}
	return c, nil
}

func (e *Engine) childRun(parent event.ID, config session.Config) func(context.Context, event.ID, string) (loop.Outcome, error) {
	return func(ctx context.Context, id event.ID, input string) (loop.Outcome, error) {
		child, err := e.newConversation(ctx, SessionOptions{Parent: parent, Provider: config.Provider, Model: config.Model, Thinking: config.Thinking, Workdir: config.Workdir})
		if err != nil {
			return loop.Outcome{}, err
		}
		defer child.runner.Env.Jobs.Close()
		child.state.ID = id
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
	id := string(e.newID())
	if err := e.store.Put(ctx, store.Doc{Kind: "blob", Key: id, Body: body, Meta: map[string]string{"title": name}}); err != nil {
		return "", err
	}
	return tool.Ref("mrk://blob/" + id), nil
}
