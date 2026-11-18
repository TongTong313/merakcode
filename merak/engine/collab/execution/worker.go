package execution

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type ClaimRun struct {
	Run     worker.Run
	Caps    definition.Caps
	Sources []event.ID
}

type claimPreparation struct {
	cancel context.CancelFunc
	inputs []loop.Input
}

func (domain *Execution) Barrier() {
	domain.mu.Lock()
	domain.mu.Unlock()
}

func (domain *Execution) Claim(id event.ID) (ClaimRun, bool) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	run, ok := domain.claimRuns[id]
	return run, ok
}

func (domain *Execution) QueuePreparingInput(id event.ID, input loop.Input) (ClaimRun, bool, bool) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	run, running := domain.claimRuns[id]
	if !running && domain.claimPreparing[id] != nil {
		preparing := domain.claimPreparing[id]
		preparing.inputs = append(preparing.inputs, input)
		return run, running, true
	}
	return run, running, false
}

func (domain *Execution) ClaimToPause(id event.ID) (ClaimRun, bool) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	run, ok := domain.claimRuns[id]
	if !ok && domain.claimPreparing[id] != nil {
		domain.claimPreparing[id].cancel()
	}
	return run, ok
}

func (domain *Execution) ClaimToCancel(id event.ID) (ClaimRun, bool) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	run, ok := domain.claimRuns[id]
	if preparing := domain.claimPreparing[id]; preparing != nil {
		preparing.cancel()
	}
	return run, ok
}

func (domain *Execution) ClaimStatus(id event.ID) (running, preparing bool) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	_, running = domain.claimRuns[id]
	_, preparing = domain.claimPreparing[id]
	return running, preparing
}

func (domain *Execution) PrepareClaim(id event.ID, cancel context.CancelFunc) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	domain.claimPreparing[id] = &claimPreparation{cancel: cancel}
}

func (domain *Execution) ForgetPreparation(id event.ID) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	delete(domain.claimPreparing, id)
}

func (domain *Execution) FinishPreparation(id event.ID, run func()) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	delete(domain.claimPreparing, id)
	domain.core.Workers.Go(run)
}

func (domain *Execution) ForgetClaim(id event.ID) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	delete(domain.claimRuns, id)
}

func (domain *Execution) StartGroupSession(id event.ID, run func()) bool {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return false
	}
	domain.groupSessions[id] = true
	domain.core.Workers.Go(run)
	return true
}

func (domain *Execution) EndGroupSession(id event.ID) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	delete(domain.groupSessions, id)
}

func (domain *Execution) HasGroupSession(id event.ID) bool {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	return domain.groupSessions[id]
}

func (domain *Execution) StartWorker(ctx context.Context, p definition.Agent, a worker.Assignment) (worker.Run, error) {
	p, err := domain.registry.WithAgentSecrets(ctx, p)
	if err != nil {
		return nil, err
	}
	if p.Disabled {
		return nil, errorcode.Coded(errorcode.AgentDisabled, errors.New("the agent is turned off"))
	}
	a.Scope.Session = a.Session
	if p.Product != nil && p.Product.Kind == definition.KindRemote {
		// The source engine enforces its own profile; the host enforces task totals.
		p.Budget = definition.Budget{}
	}
	if err := registry.ValidateAgentNetwork(p); err != nil {
		return nil, err
	}
	packetSources, err := domain.prepareTaskPacket(ctx, &p, &a)
	if err != nil {
		return nil, err
	}
	if a.Scope.Group != "" && a.Scope.Task != "" && !a.Leader {
		card, err := domain.tasks.Get(ctx, a.Scope.Task)
		if err != nil {
			return nil, err
		}
		if card.Budget.MaxSteps > 0 && (p.Budget.MaxSteps == 0 || card.Budget.MaxSteps < p.Budget.MaxSteps) {
			p.Budget.MaxSteps = card.Budget.MaxSteps
		}
	}
	if p.Product != nil && p.Product.Kind != definition.KindBuiltin {
		limit, _, err := domain.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
		if err != nil {
			return nil, err
		}
		if limit != "" {
			domain.BlockBudgetTask(ctx, a.Scope)
			return nil, worker.BudgetExceeded{Limit: limit}
		}
	}
	a.Mode = p.Mode
	if a.Claim.ID != "" {
		ctx = process.WithReflogAction(ctx, "merak-claim["+string(a.Claim.ID)+"]")
	}
	if p.Product != nil {
		switch p.Product.Kind {
		case definition.KindBuiltin, definition.KindClaudeCode, definition.KindCodex, definition.KindOpenCode, definition.KindPi, definition.KindACP, definition.KindCommand, definition.KindRemote:
		default:
			return nil, errors.New("unsupported worker product")
		}
	}
	if p.ToolPool != "" && p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" && !(a.Leader && p.ToolPool == "leader.default") {
		return nil, errors.New("unsupported worker tool pool")
	}
	if a.ReadOnly || p.ToolPool == "worker.readonly" || a.Leader {
		a.ReadOnly, p.ToolPool = true, "worker.readonly"
	}
	var binding *memberMCP
	if p.Product != nil && p.Product.Kind != definition.KindRemote && a.Claim.Task != "" && domain.runnerFor(p, nil).Caps().MCP {
		var err error
		binding, err = domain.bindWorkerMCP(ctx, &a)
		if err != nil {
			return nil, err
		}
		defer func() {
			if binding != nil {
				binding.endpoint.Close()
			}
		}()
	}
	var launcher *sandbox.Launcher
	if p.Product != nil && p.Product.Kind != definition.KindRemote {
		a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "PATH")
		for name := range p.Product.Env {
			a.SandboxProfile.EnvAllow = append(a.SandboxProfile.EnvAllow, name)
		}
		candidate := &sandbox.Launcher{StateDir: domain.sandboxStateDir, Disabled: p.Mode == permission.ModeTakeover, Reclaimable: a.Scope.Group == ""}
		candidate.Unavailable = func(ctx context.Context, status sandbox.Status) error {
			if domain.runnerFor(p, nil).Caps().Permission {
				return nil
			}
			if a.Scope.Group != "" && !status.Available {
				if err := domain.groups.SetUnconfined(ctx, a.Scope.Group, a.Claim.Member, true); err != nil {
					return err
				}
			}
			return domain.approveUnconfinedMember(ctx, p, a, status)
		}
		launcher = candidate
		launcher.MemberName = p.Name
		launcher.ApproveNetwork = func(ctx context.Context, host string) (bool, error) {
			return domain.approveWorkerNetwork(ctx, p, a, host)
		}
		launcher.NetworkDenied = func(ctx context.Context, denial sandbox.NetworkDenial) error {
			return domain.recordDeniedNetwork(ctx, p, a, denial)
		}
		launcher.ProtectionChanged = func(failure *sandbox.ProtectionError) error {
			return domain.recordProtectionChange(context.WithoutCancel(ctx), p, a, failure)
		}
		launcher.FileDenied = func(failure *sandbox.DenialError) error {
			return domain.recordFileDenial(context.WithoutCancel(ctx), p, a, failure)
		}
		network, err := domain.workerNetworkPolicy(ctx, p, a)
		if err != nil {
			return nil, err
		}
		a.SandboxProfile.Network = network
		a.SandboxProfile, err = domain.MemberSandboxProfile(ctx, a.Workdir, a.SandboxProfile)
		if err != nil {
			return nil, err
		}
		launcher = domain.keepSandbox(a.Session, launcher)
	}
	release, err := domain.AcquireMember(ctx, a.Scope, a.Claim.Member)
	if err != nil {
		return nil, err
	}
	started := false
	defer func() {
		if !started {
			release()
		}
	}()
	var initialBudget resolvedExecutionBudget
	var initialBudgetErr error
	if p.Product != nil && p.Product.Kind != definition.KindBuiltin {
		initialBudget, initialBudgetErr = domain.resolveExecutionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
	}
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		return nil, domain.core.Ctx.Err()
	}
	preparing := domain.claimPreparing[a.Claim.ID]
	if preparing != nil {
		var extra []task.Excerpt
		for _, input := range preparing.inputs {
			if input.Cause != "" && slices.Contains(packetSources, input.Cause) {
				continue
			}
			var text strings.Builder
			for _, part := range input.Parts {
				text.WriteString(part.Text)
			}
			extra = append(extra, task.Excerpt{ID: input.Cause, Actor: input.Actor, Text: text.String()})
			if input.Cause != "" {
				packetSources = append(packetSources, input.Cause)
			}
		}
		if len(extra) > 0 {
			body, err := json.Marshal(extra)
			if err != nil {
				return nil, err
			}
			a.Packet += "\nAdditional instructions received during preparation:\n" + string(body)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(domain.core.Ctx, cancel)
	ctx, stopBudget := domain.workerBudget(ctx, p, a, initialBudget, initialBudgetErr)
	done := launcher.Hold()
	run, err := domain.runnerFor(p, launcher).Start(ctx, a)
	if err != nil {
		stopBudget()
		done()
		stop()
		cancel()
		return nil, err
	}
	if binding != nil {
		run = &mcpWorkerRun{Run: run, binding: binding}
		binding = nil
	}
	if preparing != nil {
		domain.claimRuns[a.Claim.ID] = ClaimRun{Run: run, Caps: domain.runnerFor(p, nil).Caps(), Sources: packetSources}
	}
	if a.Scope.Group != "" {
		domain.groupSessions[a.Session] = true
	}
	started = true
	domain.core.Workers.Go(func() {
		defer stopBudget()
		defer release()
		defer done()
		if a.Scope.Group != "" {
			defer domain.ReleaseSandbox(a.Session)
		}
		defer domain.EndGroupSession(a.Session)
		defer stop()
		defer cancel()
		_, _ = run.Wait(context.Background())
	})
	return run, nil
}

func (domain *Execution) RunAssignment(ctx context.Context, p definition.Agent, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
	priorState, loadErr := domain.manager.Load(ctx, a.Session)
	if loadErr != nil && !errors.Is(loadErr, store.ErrNotFound) {
		return loop.Outcome{}, loadErr
	}
	var c *conversation.Conversation
	var err error
	if loadErr == nil {
		prior := priorState.Read()
		if prior.Config.Member != a.Claim.Member || prior.Scope.Group != a.Scope.Group || prior.Scope.Task != a.Scope.Task {
			return loop.Outcome{}, errors.New("assignment does not match the existing session")
		}
		c, err = domain.conversation.ConversationFor(priorState)
	} else {
		var chosen definition.ModelRef
		if chosen, err = domain.registry.MemberModel(p.Model); err != nil {
			return loop.Outcome{}, err
		}
		c, err = domain.conversation.NewConversation(ctx, conversation.SessionOptions{ID: a.Session, Scope: a.Scope, Member: a.Claim.Member, Mode: p.Mode, Provider: chosen.Provider, Model: chosen.Model, Thinking: chosen.Thinking, Workdir: a.Workdir, System: p.System, ToolPool: p.ToolPool, Budget: p.Budget})
	}
	if err != nil {
		return loop.Outcome{}, err
	}
	defer domain.ReleaseSandbox(c.State.Read().ID)
	defer c.Runner.Env.Jobs.Close()
	if c.Children != nil {
		defer c.Children.Close()
	}
	c.Runner.Steer = JoinedSteer{steer, c.Runner.Steer}
	var report *task.Report
	if a.Claim.Task != "" {
		c.Runner.Tools = c.Runner.Tools.With(domain.workerTools(a, func(_ context.Context, value task.Report) error { report = &value; return nil })...)
		c.State.SetTools(c.Runner.Tools.Specs(), "")
		c.Runner.Finish = func() []model.Part {
			if report == nil {
				return nil
			}
			body, _ := json.Marshal(report)
			return []model.Part{{Text: string(body)}}
		}
	}
	if loadErr != nil {
		c.State, err = domain.manager.Create(ctx, *c.State)
		if err != nil {
			return loop.Outcome{}, err
		}
	}
	input := loop.Input{Parts: []model.Part{{Text: a.Packet}}, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: a.Cause, Sources: a.Sources}
	outcome, err := domain.conversation.RunInput(ctx, c, input)
	if err == nil && report != nil && a.Claim.Task != "" {
		outcome.Usage = outcome.Usage.Add(domain.offerUnclaimedTasks(ctx, c, a))
	}
	if err != nil || a.Claim.Task == "" || report != nil || outcome.Stop != loop.Answered {
		return outcome, err
	}
	input.Parts = []model.Part{{Text: "Please submit your report with submit_report. Include what you did and how you verified it."}}
	previous := outcome.Final
	usage := outcome.Usage
	outcome, err = domain.conversation.RunInput(ctx, c, input)
	outcome.Usage = usage.Add(outcome.Usage)
	if err == nil && report == nil {
		var text strings.Builder
		for _, part := range outcome.Final {
			text.WriteString(part.Text)
		}
		if strings.TrimSpace(text.String()) == "" {
			for _, part := range previous {
				text.WriteString(part.Text)
			}
		}
		outcome.Final = []model.Part{{Text: "Worker ended without submitting a report. " + text.String()}}
	}
	return outcome, err
}

type JoinedSteer struct{ First, Second loop.Steer }

func (s JoinedSteer) Poll() []loop.Input {
	var inputs []loop.Input
	if s.First != nil {
		inputs = append(inputs, s.First.Poll()...)
	}
	if s.Second != nil {
		inputs = append(inputs, s.Second.Poll()...)
	}
	return inputs
}
func (s JoinedSteer) Preempt() <-chan struct{} {
	if s.First != nil {
		return s.First.Preempt()
	}
	if s.Second != nil {
		return s.Second.Preempt()
	}
	return nil
}

// offerUnclaimedTasks gives a Worker that has just reported one more short turn when its group has open tasks
// nobody holds, so it can claim one. Nothing runs when there is nothing to claim.
func (domain *Execution) offerUnclaimedTasks(ctx context.Context, c *conversation.Conversation, a worker.Assignment) model.Usage {
	cards, err := domain.tasks.List(ctx, a.Scope.Group)
	if err != nil {
		return model.Usage{}
	}
	var lines []string
	for _, card := range task.Claimable(cards) {
		lines = append(lines, "- "+string(card.ID)+": "+card.Title)
	}
	if len(lines) == 0 {
		return model.Usage{}
	}
	text := "Unclaimed work in your group:\n" + strings.Join(lines, "\n") + "\nYour report is in. If one of these fits you, take it with claim_task; otherwise reply with a single word."
	outcome, _ := domain.conversation.RunInput(ctx, c, loop.Input{Parts: []model.Part{{Text: text}}, Actor: event.Actor{Kind: "system"}})
	return outcome.Usage
}

func (domain *Execution) WorkerProducts(ctx context.Context) []worker.ProductInfo {
	return worker.Catalog(ctx)
}

// conversationEnvironment supplies the existing execution environment to a native conversation.
func (domain *Execution) ConversationEnvironment(ctx context.Context, state *session.State, env *tool.Env) error {
	launcher := &sandbox.Launcher{StateDir: domain.sandboxStateDir, Disabled: state.Config.Mode == permission.ModeTakeover, Reclaimable: state.Scope.Group == ""}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	configuration, err := domain.MemberSandboxProfile(ctx, state.Config.Workdir, sandbox.Profile{Network: sandbox.Network{Mode: "allowlist"}})
	if err != nil {
		return err
	}
	configuration, err = DenyProductState(configuration)
	if err != nil {
		return err
	}
	env.Sandbox = launcher
	env.SandboxProfile = configuration
	memberAgent := definition.DefaultMerakCode()
	if state.Scope.Group != "" && state.Config.Member != "" {
		groupID, memberID := domain.roster.ExecutionSource(state.Scope, state.Config.Member)
		member, err := domain.roster.GroupMember(ctx, groupID, memberID)
		if err != nil {
			return err
		}
		memberAgent, err = domain.roster.MemberAgent(ctx, member)
		if err != nil {
			return err
		}
	}
	assignment := worker.Assignment{Session: state.ID, Scope: state.Scope, Workdir: state.Config.Workdir, Claim: task.Claim{Member: state.Config.Member}, SandboxProfile: configuration}
	network, err := domain.workerNetworkPolicy(ctx, memberAgent, assignment)
	if err != nil {
		return err
	}
	env.SandboxProfile.Network = network
	domain.connectSandboxNetwork(launcher, memberAgent, assignment)
	env.Sandbox = domain.keepSandbox(state.ID, launcher)
	env.MemoryOwners = domain.roster.MemberMemoryOwners(ctx, state.Config.Workdir, state.Scope, state.Config.Member)
	return nil
}

func (domain *Execution) ConversationRelease(_ context.Context, _ *conversation.Conversation, id event.ID, stage conversation.EndStage) error {
	if stage == conversation.Close {
		domain.ReleaseSandbox(id)
	}
	return nil
}
