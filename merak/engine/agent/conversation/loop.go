package conversation

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/prompt"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/rules"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/agent/window"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Manager) Chat(ctx context.Context, provider, input string) (loop.Outcome, error) {
	c, err := domain.NewConversation(ctx, SessionOptions{Provider: provider})
	if err != nil {
		return loop.Outcome{}, err
	}
	defer domain.afterTurn(domain.core.Ctx, c, c.State.Read().ID, Close)
	defer c.Runner.Env.Jobs.Close()
	if c.Children != nil {
		defer c.Children.Close()
	}
	return domain.runConversation(ctx, c, []model.Part{{Text: input}})
}

func (domain *Manager) NewConversation(ctx context.Context, options SessionOptions) (*Conversation, error) {
	if err := config.ValidateMCPServers(options.MCPServers); err != nil {
		return nil, err
	}
	if err := options.Budget.Validate(); err != nil {
		return nil, err
	}
	if options.Mode != "" && options.Mode != permission.ModeAsk && options.Mode != permission.ModeAuto && options.Mode != permission.ModeTakeover {
		return nil, fmt.Errorf("MRK-4001")
	}
	options.Workdir = registry.CanonicalDirectory(options.Workdir)
	if options.Workdir == "" {
		options.Workdir = registry.CanonicalDirectory(domain.core.Workdir)
	}
	if err := folder.Existing(options.Workdir); err != nil {
		return nil, errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	if domain.registry.Provider(options.Provider) == nil {
		return nil, fmt.Errorf("unknown provider %q", options.Provider)
	}
	if options.Model == "" {
		options.Model = domain.model
	}
	if options.Thinking == "" {
		options.Thinking = domain.thinking
	}
	system, describes, err := domain.ComposeSystem(ctx, options)
	if err != nil {
		return nil, err
	}
	if options.ID == "" {
		options.ID = domain.core.NewID()
	}
	state := &session.State{ID: options.ID, Scope: options.Scope, System: system, Config: session.Config{Mode: options.Mode, Member: options.Member, ToolPool: options.ToolPool, Parent: options.Parent, Provider: options.Provider, Model: options.Model, Thinking: options.Thinking, Workdir: options.Workdir, Switches: options.Switches}}
	state.Config.Budget = options.Budget
	if options.Budget.MaxWallClock > 0 {
		state.Config.BudgetDeadline = domain.core.Now().Add(options.Budget.MaxWallClock)
	}
	state.BaseCommit, _ = git.Current(ctx, options.Workdir)
	state.Tools = domain.sessionTools(state.Config).Specs()
	c, err := domain.ConversationFor(state)
	if err == nil && len(options.Tools) > 0 {
		keep := func(name string) bool { return slices.Contains(options.Tools, name) }
		for name := range c.Runner.Tools.Tools {
			if !keep(name) {
				delete(c.Runner.Tools.Tools, name)
			}
		}
		for name := range c.Runner.Tools.Deferred {
			if !keep(name) {
				delete(c.Runner.Tools.Deferred, name)
			}
		}
		c.State.SetTools(c.Runner.Tools.Specs(), "")
	}
	if err == nil && describes {
		c.State.SetTools(c.Runner.Tools.Specs(), "")
	}
	if err == nil && len(options.MCPServers) > 0 {
		body, _ := json.Marshal(options.MCPServers)
		_ = json.Unmarshal(body, &c.mcpServers)
	}
	return c, err
}

// ComposeSystem builds the system prompt of a conversation in a folder: the product prompt, the user's and the
// project's rules, and the skills. A folder that is gone has neither rules nor skills. describes says that the rules
// or skills carry descriptions the model loads tools for.
func (domain *Manager) ComposeSystem(ctx context.Context, options SessionOptions) (system string, describes bool, err error) {
	situation := prompt.Situation{
		Role:   options.Role,
		System: domain.system + "\n" + options.System, Environment: prompt.Environment{OS: runtime.GOOS, Shell: "bash", Workdir: options.Workdir},
		Deferred: domain.sessionTools(session.Config{Parent: options.Parent, ToolPool: options.ToolPool, Switches: options.Switches}).DeferredSpecs(),
	}
	situation.Personal = domain.registry.PersonalRules()
	if folder.Existing(options.Workdir) == nil {
		projectRules, err := rules.Load(ctx, options.Workdir)
		if err != nil {
			return "", false, err
		}
		skills, err := domain.registry.Skills(options.Workdir)
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
		situation.Deferred = domain.sessionTools(session.Config{Parent: options.Parent, Switches: options.Switches}).DeferredSpecs()
		situation.System += "\nYou are a read-only child. Research the assigned question and return a concise report. You cannot modify files, claim tasks or start children."
	}
	return (prompt.Composer{}).System(situation), describes, nil
}

func (domain *Manager) ConversationFor(live *session.State) (*Conversation, error) {
	state := live.Read()
	p := domain.registry.Provider(state.Config.Provider)
	if p == nil {
		return nil, fmt.Errorf("unknown provider %q", state.Config.Provider)
	}
	runner := loop.Loop{Model: p, ModelID: state.Config.Model, Thinking: state.Config.Thinking, Bus: domain.core.Bus, Tools: domain.sessionTools(state.Config), Env: tool.Env{Member: state.Config.Member, Mode: string(state.Config.Mode), Workdir: state.Config.Workdir, Reads: new(tool.Reads), Jobs: new(tool.Jobs), Spill: domain.spill}}
	runner.Limits = state.Config.Budget
	if err := domain.hooks.Environment(domain.core.Ctx, state, &runner.Env); err != nil {
		return nil, err
	}
	runner.Env.Spill = func(ctx context.Context, name string, body []byte) (tool.Ref, error) {
		return domain.spillScoped(ctx, live.Read().Scope, name, body)
	}
	if state.Config.Parent == "" {
		if skills, err := domain.registry.Skills(state.Config.Workdir); err == nil && len(skills.Skills) > 0 {
			runner.Tools = runner.Tools.With(tool.Skill{Read: skills.Read})
		}
		if set, err := rules.Load(domain.core.Ctx, state.Config.Workdir); err == nil {
			runner.Env.Attach = set.Attacher(state.Config.Workdir)
			if set.HasDescribed() {
				runner.Tools = runner.Tools.With(tool.Rule{Lookup: set.Lookup})
			}
		}
	}
	for _, configure := range domain.hooks.Loop {
		configure(LoopTools, state, &runner)
	}
	runner.Tools.RestoreLoaded(state.Loaded)
	runner.Snapshot = domain.manager.Snapshot
	for _, configure := range domain.hooks.Loop {
		configure(LoopTrack, state, &runner)
	}
	entry := domain.catalog.Get(state.Config.Provider, state.Config.Model)
	reserve := max(entry.MaxOutput/4, 8192)
	runner.Window = &window.Builder{Budget: window.Budget{Window: entry.Window, Reserve: reserve, Trigger: .9, Target: .6, KeepTurns: 4, ResultCap: 50 * 1024}, Counter: domain.counter, Bus: domain.core.Bus, Summarize: domain.registry.Summarizer(p)}
	runner.Window.Snapshot = domain.manager.Snapshot
	c := &Conversation{State: live, Runner: runner, queue: make(chan *conversationTurn, 1), Turns: make(map[*conversationTurn]struct{})}
	if state.Config.Parent == "" && state.Scope.Group == "" {
		if skills, err := domain.registry.Skills(state.Config.Workdir); err == nil {
			c.Recommender = skills.Recommender()
		}
	}
	if state.Config.Parent == "" {
		c.Children = domain.hooks.Children(domain.core.Ctx, domain.childRun(state.ID, state.Scope, state.Config))
		c.Runner.Env.Children = c.Children
		c.Runner.Steer = c.Children
	}
	return c, nil
}

func (domain *Manager) childRun(parent event.ID, scope event.Scope, config session.Config) func(context.Context, event.ID, string) (loop.Outcome, error) {
	return func(ctx context.Context, id event.ID, input string) (loop.Outcome, error) {
		childScope := event.Scope{Group: scope.Group, Task: scope.Task, Session: id}
		options := SessionOptions{ID: id, Parent: parent, Scope: childScope, Member: config.Member, Mode: config.Mode, Provider: config.Provider, Model: config.Model, Thinking: config.Thinking, Workdir: config.Workdir, Budget: config.Budget}
		if name := domain.hooks.ChildAgent(ctx); name != "" {
			found, ok := domain.registry.AgentNamed(name, config.Workdir)
			if !ok {
				return loop.Outcome{}, errorcode.Coded(errorcode.SessionRequestFailed, fmt.Errorf("no agent is named %s", name))
			}
			options.System = found.System
			if found.Model.Provider != "" && found.Model.Model != "" {
				options.Provider, options.Model, options.Thinking = found.Model.Provider, found.Model.Model, found.Model.Thinking
			}
			options.Tools, options.Switches = found.Tools, found.Switches
		}
		child, err := domain.NewConversation(ctx, options)
		if err != nil {
			return loop.Outcome{}, err
		}
		defer domain.afterTurn(ctx, child, child.State.Read().ID, Close)
		defer child.Runner.Env.Jobs.Close()
		child.State, err = domain.manager.Create(ctx, *child.State)
		if err != nil {
			return loop.Outcome{}, err
		}
		return domain.runConversation(ctx, child, []model.Part{{Text: input}})
	}
}

func (domain *Manager) sessionTools(config session.Config) *tool.Pool {
	pool := domain.tools.With()
	enabled := func(name string) bool {
		return domain.registry.ToolEnabled(name) && registry.SwitchedOn(config.Switches, name)
	}
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

func (domain *Manager) spill(ctx context.Context, name string, body []byte) (tool.Ref, error) {
	return domain.spillScoped(ctx, event.Scope{}, name, body)
}

func (domain *Manager) spillScoped(ctx context.Context, scope event.Scope, name string, body []byte) (tool.Ref, error) {
	id := string(domain.core.NewID())
	if err := domain.core.Store.Put(ctx, store.Doc{Kind: "blob", Key: id, Body: body, Meta: map[string]string{"title": name, "group": string(scope.Group), "session": string(scope.Session)}}); err != nil {
		return "", err
	}
	return tool.Ref("mrk://blob/" + id), nil
}
