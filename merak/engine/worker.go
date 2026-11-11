package engine

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/window"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func (e *Engine) StartWorker(ctx context.Context, p agent.Agent, a worker.Assignment) (worker.Run, error) {
	p, err := e.withAgentSecrets(ctx, p)
	if err != nil {
		return nil, err
	}
	a.Scope.Session = a.Session
	if p.Product != nil && p.Product.Kind == worker.KindRemote {
		// The source engine enforces its own profile; the host enforces task totals.
		p.Budget = agent.Budget{}
	}
	if err := validateAgentNetwork(p); err != nil {
		return nil, err
	}
	packetSources, err := e.prepareTaskPacket(ctx, &p, &a)
	if err != nil {
		return nil, err
	}
	if a.Scope.Group != "" && a.Scope.Task != "" && !a.Leader {
		card, err := e.Tasks.Get(ctx, a.Scope.Task)
		if err != nil {
			return nil, err
		}
		if card.Budget.MaxSteps > 0 && (p.Budget.MaxSteps == 0 || card.Budget.MaxSteps < p.Budget.MaxSteps) {
			p.Budget.MaxSteps = card.Budget.MaxSteps
		}
	}
	if p.Product != nil && p.Product.Kind != worker.KindBuiltin {
		limit, _, err := e.executionBudget(ctx, a.Scope, a.Claim.Member, p.Budget)
		if err != nil {
			return nil, err
		}
		if limit != "" {
			e.blockBudgetTask(ctx, a.Scope)
			return nil, worker.BudgetExceeded{Limit: limit}
		}
	}
	a.Mode = p.Mode
	if a.Claim.ID != "" {
		ctx = process.WithReflogAction(ctx, "merak-claim["+string(a.Claim.ID)+"]")
	}
	if p.Product != nil {
		switch p.Product.Kind {
		case worker.KindBuiltin, worker.KindClaudeCode, worker.KindCodex, worker.KindOpenCode, worker.KindPi, worker.KindACP, worker.KindCommand, worker.KindRemote:
		default:
			return nil, errors.New("unsupported worker product")
		}
	}
	if p.ToolPool != "" && p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" && !(a.Leader && p.Role == agent.Leader && p.ToolPool == "leader.default") {
		return nil, errors.New("unsupported worker tool pool")
	}
	if a.ReadOnly || p.ToolPool == "worker.readonly" || a.Leader {
		a.ReadOnly, p.ToolPool = true, "worker.readonly"
	}
	var binding *memberMCP
	if p.Product != nil && p.Product.Kind != worker.KindRemote && a.Claim.Task != "" && e.runnerFor(p, nil).Caps().MCP {
		var err error
		binding, err = e.bindWorkerMCP(ctx, &a)
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
	if p.Product != nil && p.Product.Kind != worker.KindRemote {
		a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "PATH")
		for name := range p.Product.Env {
			a.SandboxProfile.EnvAllow = append(a.SandboxProfile.EnvAllow, name)
		}
		candidate := &sandbox.Launcher{StateDir: e.sandboxStateDir, Disabled: p.Mode == permission.ModeTakeover, Reclaimable: a.Scope.Group == ""}
		candidate.Unavailable = func(ctx context.Context, status sandbox.Status) error {
			if e.runnerFor(p, nil).Caps().Permission {
				return nil
			}
			if a.Scope.Group != "" && !status.Available {
				if err := e.Groups.SetUnconfined(ctx, a.Scope.Group, a.Claim.Member, true); err != nil {
					return err
				}
			}
			return e.approveUnconfinedMember(ctx, p, a, status)
		}
		launcher = candidate
		launcher.MemberName = p.Name
		launcher.ApproveNetwork = func(ctx context.Context, host string) (bool, error) { return e.approveWorkerNetwork(ctx, p, a, host) }
		launcher.NetworkDenied = func(ctx context.Context, denial sandbox.NetworkDenial) error {
			return e.recordDeniedNetwork(ctx, p, a, denial)
		}
		launcher.ProtectionChanged = func(failure *sandbox.ProtectionError) error {
			return e.recordProtectionChange(context.WithoutCancel(ctx), p, a, failure)
		}
		launcher.FileDenied = func(failure *sandbox.DenialError) error {
			return e.recordFileDenial(context.WithoutCancel(ctx), p, a, failure)
		}
		network, err := e.workerNetworkPolicy(ctx, p, a)
		if err != nil {
			return nil, err
		}
		a.SandboxProfile.Network = network
		a.SandboxProfile, err = e.memberSandboxProfile(ctx, a.Workdir, a.SandboxProfile)
		if err != nil {
			return nil, err
		}
		launcher = e.keepSandbox(a.Session, launcher)
	}
	release, err := e.acquireMember(ctx, a.Scope, a.Claim.Member)
	if err != nil {
		return nil, err
	}
	started := false
	defer func() {
		if !started {
			release()
		}
	}()
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return nil, e.ctx.Err()
	}
	preparing := e.claimPreparing[a.Claim.ID]
	if preparing != nil {
		var extra []window.Excerpt
		for _, input := range preparing.inputs {
			if input.Cause != "" && slices.Contains(packetSources, input.Cause) {
				continue
			}
			var text strings.Builder
			for _, part := range input.Parts {
				text.WriteString(part.Text)
			}
			extra = append(extra, window.Excerpt{ID: input.Cause, Actor: input.Actor, Text: text.String()})
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
	stop := context.AfterFunc(e.ctx, cancel)
	ctx, stopBudget := e.workerBudget(ctx, p, a)
	done := launcher.Hold()
	run, err := e.runnerFor(p, launcher).Start(ctx, a)
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
		e.claimRuns[a.Claim.ID] = claimRun{run: run, caps: e.runnerFor(p, nil).Caps(), sources: packetSources}
	}
	if a.Scope.Group != "" {
		e.groupSessions[a.Session] = true
	}
	started = true
	e.workers.Go(func() {
		defer stopBudget()
		defer release()
		defer done()
		if a.Scope.Group != "" {
			defer e.releaseSandbox(a.Session)
		}
		defer func() { e.mu.Lock(); delete(e.groupSessions, a.Session); e.mu.Unlock() }()
		defer stop()
		defer cancel()
		_, _ = run.Wait(context.Background())
	})
	return run, nil
}

func (e *Engine) runAssignment(ctx context.Context, p agent.Agent, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
	priorState, loadErr := e.manager.Load(ctx, a.Session)
	if loadErr != nil && !errors.Is(loadErr, store.ErrNotFound) {
		return loop.Outcome{}, loadErr
	}
	var c *conversation
	var err error
	if loadErr == nil {
		if priorState.Config.Member != a.Claim.Member || priorState.Scope.Group != a.Scope.Group || priorState.Scope.Task != a.Scope.Task {
			return loop.Outcome{}, errors.New("assignment does not match the existing session")
		}
		c, err = e.conversationFor(priorState)
	} else {
		var chosen agent.ModelRef
		if chosen, err = e.memberModel(p.Model); err != nil {
			return loop.Outcome{}, err
		}
		c, err = e.newConversation(ctx, SessionOptions{ID: a.Session, Scope: a.Scope, Member: a.Claim.Member, Mode: p.Mode, Provider: chosen.Provider, Model: chosen.Model, Thinking: chosen.Thinking, Workdir: a.Workdir, System: p.System, ToolPool: p.ToolPool, Budget: p.Budget})
	}
	if err != nil {
		return loop.Outcome{}, err
	}
	defer e.releaseSandbox(c.state.ID)
	defer c.runner.Env.Jobs.Close()
	if c.children != nil {
		defer c.children.Close()
	}
	c.runner.Steer = joinedSteer{steer, c.runner.Steer}
	var report *task.Report
	if a.Claim.Task != "" {
		c.runner.Tools = c.runner.Tools.With(e.workerTools(a, func(_ context.Context, value task.Report) error { report = &value; return nil })...)
		c.state.Tools = c.runner.Tools.Specs()
		c.runner.Finish = func() []model.Part {
			if report == nil {
				return nil
			}
			body, _ := json.Marshal(report)
			return []model.Part{{Text: string(body)}}
		}
	}
	if loadErr != nil {
		c.state, err = e.manager.Create(ctx, *c.state)
		if err != nil {
			return loop.Outcome{}, err
		}
	}
	input := loop.Input{Parts: []model.Part{{Text: a.Packet}}, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: a.Cause, Sources: a.Sources}
	outcome, err := e.runInput(ctx, c, input)
	if err == nil && report != nil && a.Claim.Task != "" {
		outcome.Usage = outcome.Usage.Add(e.offerUnclaimedTasks(ctx, c, a))
	}
	if err != nil || a.Claim.Task == "" || report != nil || outcome.Stop != loop.Answered {
		return outcome, err
	}
	input.Parts = []model.Part{{Text: "Please submit your report with submit_report. Include what you did and how you verified it."}}
	previous := outcome.Final
	usage := outcome.Usage
	outcome, err = e.runInput(ctx, c, input)
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

type joinedSteer struct{ first, second loop.Steer }

func (s joinedSteer) Poll() []loop.Input {
	var inputs []loop.Input
	if s.first != nil {
		inputs = append(inputs, s.first.Poll()...)
	}
	if s.second != nil {
		inputs = append(inputs, s.second.Poll()...)
	}
	return inputs
}
func (s joinedSteer) Preempt() <-chan struct{} {
	if s.first != nil {
		return s.first.Preempt()
	}
	if s.second != nil {
		return s.second.Preempt()
	}
	return nil
}

// offerUnclaimedTasks gives a Worker that has just reported one more short turn when its group has open tasks
// nobody holds, so it can claim one. Nothing runs when there is nothing to claim.
func (e *Engine) offerUnclaimedTasks(ctx context.Context, c *conversation, a worker.Assignment) model.Usage {
	cards, err := e.Tasks.List(ctx, a.Scope.Group)
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
	outcome, _ := e.runInput(ctx, c, loop.Input{Parts: []model.Part{{Text: text}}, Actor: event.Actor{Kind: "system"}})
	return outcome.Usage
}
