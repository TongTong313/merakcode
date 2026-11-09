package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func (e *Engine) StartWorker(ctx context.Context, p profile.Profile, a worker.Assignment) (worker.Run, error) {
	if err := validateProfileNetwork(p); err != nil {
		return nil, err
	}
	a.Mode = p.Mode
	if a.Claim.ID != "" {
		ctx = process.WithReflogAction(ctx, "merak-claim["+string(a.Claim.ID)+"]")
	}
	if p.Product != nil {
		switch p.Product.Kind {
		case worker.KindBuiltin, worker.KindClaudeCode, worker.KindCodex, worker.KindOpenCode, worker.KindPi, worker.KindACP, worker.KindCommand:
		default:
			return nil, errors.New("unsupported worker product")
		}
	}
	if p.ToolPool != "" && p.ToolPool != "worker.default" && p.ToolPool != "worker.readonly" {
		return nil, errors.New("unsupported worker tool pool")
	}
	if a.ReadOnly || p.ToolPool == "worker.readonly" {
		a.ReadOnly, p.ToolPool = true, "worker.readonly"
	}
	var launcher *sandbox.Launcher
	if p.Product != nil {
		a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "PATH")
		for name := range p.Product.Env {
			a.SandboxProfile.EnvAllow = append(a.SandboxProfile.EnvAllow, name)
		}
		candidate := &sandbox.Launcher{Disabled: p.Mode == permission.ModeTakeover}
		candidate.Unavailable = func(ctx context.Context, status sandbox.Status) error {
			if e.runnerFor(p, nil).Caps().Permission {
				return nil
			}
			if a.Scope.Group != "" {
				if err := e.Groups.SetUnconfined(ctx, a.Scope.Group, a.Claim.Member, true); err != nil {
					return err
				}
			}
			return e.approveUnconfinedMember(ctx, p, a, status)
		}
		launcher = candidate
		if candidate.Disabled || candidate.Status(ctx, a.SandboxProfile).Available {
			launcher.MemberName = p.Name
			launcher.ApproveNetwork = func(ctx context.Context, host string) (bool, error) { return e.approveWorkerNetwork(ctx, p, a, host) }
			launcher.NetworkDenied = func(ctx context.Context, host string) error { return e.recordDeniedNetwork(ctx, p, a, host) }
			hosts, err := e.workerNetworkHosts(ctx, p, a)
			if err != nil {
				return nil, err
			}
			a.SandboxProfile.Network.Mode, a.SandboxProfile.Network.Hosts = "allowlist", hosts
			a.SandboxProfile, err = memberSandboxProfile(ctx, a.Workdir, a.SandboxProfile)
			if err != nil {
				return nil, err
			}
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		return nil, e.ctx.Err()
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(e.ctx, cancel)
	run, err := e.runnerFor(p, launcher).Start(ctx, a)
	if err != nil {
		stop()
		cancel()
		return nil, err
	}
	if a.Scope.Group != "" {
		e.groupSessions[a.Session] = true
	}
	e.workers.Go(func() {
		defer func() { e.mu.Lock(); delete(e.groupSessions, a.Session); e.mu.Unlock() }()
		defer stop()
		defer cancel()
		_, _ = run.Wait(context.Background())
	})
	return run, nil
}

func (e *Engine) runAssignment(ctx context.Context, p profile.Profile, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
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
		c, err = e.newConversation(ctx, SessionOptions{ID: a.Session, Scope: a.Scope, Member: a.Claim.Member, Mode: p.Mode, Provider: p.Model.Provider, Model: p.Model.Model, Thinking: p.Model.Thinking, Workdir: a.Workdir, System: p.System, ToolPool: p.ToolPool})
	}
	if err != nil {
		return loop.Outcome{}, err
	}
	defer c.runner.Env.Jobs.Close()
	if c.children != nil {
		defer c.children.Close()
	}
	c.runner.Steer = joinedSteer{steer, c.runner.Steer}
	var report *task.Report
	if a.Claim.Task != "" {
		c.runner.Tools = c.runner.Tools.With(e.askLeaderTool(a))
		c.runner.Tools = c.runner.Tools.With(tool.AskUser{Bus: e.Bus, Ask: e.askQuestion})
		c.runner.Tools = c.runner.Tools.With(tool.SubmitReport{Claim: a.Claim.ID, Submit: func(_ context.Context, value task.Report) error { report = &value; return nil }})
		c.runner.Tools = c.runner.Tools.With(tool.ReportProgress{Report: func(ctx context.Context, summary string) error {
			body, _ := json.Marshal(task.Progress{Claim: a.Claim.ID, Summary: summary})
			_, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope, Type: task.Progressed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
			return err
		}})
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
	input := loop.Input{Parts: []model.Part{{Text: a.Packet}}, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: a.Cause}
	outcome, err := e.runInput(ctx, c, input)
	if err != nil || a.Claim.Task == "" || report != nil {
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
