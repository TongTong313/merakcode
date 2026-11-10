package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/prompt"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type leaderRuntime interface {
	Send(context.Context, loop.Input) error
	Close()
}

type builtinLeader struct {
	engine       *Engine
	conversation *conversation
	reset        func()
}

func (r *builtinLeader) Send(ctx context.Context, input loop.Input) error {
	r.reset()
	outcome, err := r.engine.runInput(ctx, r.conversation, input)
	if err == nil && loop.BudgetStop(outcome.Stop) {
		return worker.BudgetExceeded{Limit: outcome.Stop}
	}
	return err
}
func (r *builtinLeader) Close() {
	r.engine.releaseSandbox(r.conversation.state.ID)
	r.conversation.runner.Env.Jobs.Close()
	if r.conversation.children != nil {
		r.conversation.children.Close()
	}
}

type externalLeader struct {
	scheduler  *leader.Scheduler
	digest     leader.Digest
	engine     *Engine
	profile    profile.Profile
	assignment worker.Assignment
	endpoint   *mcp.Endpoint
	run        worker.Run
	initial    string
	fail       context.CancelCauseFunc
	done       chan struct{}
}

func (e *Engine) externalLeaderRuntime(ctx context.Context, g *groupRun, thread *leader.Thread, p profile.Profile, fail context.CancelCauseFunc) (leaderRuntime, error) {
	caps := e.runnerFor(p, nil).Caps()
	if !caps.MCP || !caps.Steer {
		return nil, errors.New("external leaders require MCP and steering")
	}
	saved, err := e.manager.Load(ctx, thread.Session.ID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		thread.Session = saved
	}
	a := worker.Assignment{Leader: true, ReadOnly: true, Mode: p.Mode, Session: thread.Session.ID, Scope: thread.Session.Scope, Workdir: g.group.Project.Directory, Claim: task.Claim{Member: thread.Leader}}
	a.LeaderTurn = worker.NewLeaderTurn()
	server := e.leaderMCPServer(g, thread, a.LeaderTurn.Finish)
	for name, operation := range server.Tools.Tools {
		server.Tools.Tools[name] = leaderTurnTool{Tool: operation, turn: a.LeaderTurn}
	}
	endpoint, err := mcp.Listen(ctx, server, "leader", string(thread.Key))
	if err != nil {
		return nil, err
	}
	a.MCP, err = e.mcpConfiguration(endpoint, "leader", string(thread.Key))
	if err != nil {
		endpoint.Close()
		return nil, err
	}
	for _, spec := range server.Tools.Specs() {
		a.MCP.Tools = append(a.MCP.Tools, spec.Name)
	}
	a.SandboxProfile.Network.LocalPorts = append(a.SandboxProfile.Network.LocalPorts, endpoint.Port)
	initial := ""
	if saved == nil || len(saved.Messages) == 0 {
		initial = (prompt.Composer{}).System(prompt.Situation{Role: "leader", System: p.System, Environment: prompt.Environment{OS: runtime.GOOS, Workdir: a.Workdir}})
	}
	body, _ := json.Marshal(leader.Handover{Key: thread.Key, Leader: thread.Leader, Session: a.Session})
	if _, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + g.group.ID), Scope: a.Scope, Type: leader.ThreadStarted, Actor: event.Actor{Kind: event.ActorAgent, ID: thread.Leader}, Payload: body}); err != nil {
		endpoint.Close()
		return nil, err
	}
	return &externalLeader{engine: e, profile: p, assignment: a, endpoint: endpoint, initial: initial, fail: fail, scheduler: thread.Scheduler, digest: leader.Digest{State: g.state, Focus: thread.Session.Scope.Task}}, nil
}

type leaderTurnTool struct {
	tool.Tool
	turn *worker.LeaderTurn
}

func (t leaderTurnTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	release, err := t.turn.Enter(ctx)
	if err != nil {
		return tool.Result{}, err
	}
	defer release()
	return t.Tool.Run(ctx, call)
}

func (r *externalLeader) Send(ctx context.Context, input loop.Input) error {
	facts, stop := r.engine.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: r.assignment.Session}, Types: []event.Type{session.MessageSent, loop.TurnFinished}})
	defer stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	recorded, awaiting := false, true
	cause := input.Cause
	var steering []event.Event
	var completed event.Event
	restore := func() {
		for _, fact := range steering {
			r.scheduler.Enqueue(fact)
		}
		steering = nil
	}
	abort := func(reason error) error {
		r.fail(reason)
		ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if r.run != nil {
			_ = r.run.Cancel(ending)
			<-r.done
		}
		// Persistence may complete before Publish delivers the corresponding event.
		// Stop the writer before deciding whether the scheduler must retry an input.
		var persisted []event.Event
		for {
			reading, stopRead := context.WithTimeout(r.engine.ctx, 5*time.Second)
			var err error
			persisted, err = r.engine.store.Read(reading, event.Stream("session:"+r.assignment.Session), 1, 0)
			stopRead()
			if err == nil {
				break
			}
			// Retain the in-flight batch until durable delivery can be checked.
			select {
			case <-r.engine.ctx.Done():
				return errors.Join(reason, err)
			case <-time.After(250 * time.Millisecond):
			}
		}
		for _, fact := range persisted {
			if fact.Type != session.MessageSent {
				continue
			}
			if fact.Cause == input.Cause {
				recorded = true
			}
			if awaiting && fact.Cause == cause {
				steering = nil
			}
		}
		restore()
		if recorded {
			return nil
		}
		return reason
	}
	if err := r.sendInput(ctx, input); err != nil {
		return abort(err)
	}
	accept := func(fact event.Event) {
		if fact.Type != session.MessageSent || !awaiting || fact.Cause != cause {
			return
		}
		if steering == nil {
			recorded = true
		}
		steering = nil
		awaiting = false
		if completed.Scope.Turn != fact.Scope.Turn {
			completed = event.Event{}
		}
	}
	for {
		if recorded && !awaiting && completed.ID != "" {
			outcome, _ := event.Decode[loop.Outcome](completed)
			if outcome.Stop != loop.Answered {
				r.fail(errors.New("external leader turn failed"))
				return nil
			}
			pending := false
			if r.profile.Product.Kind == worker.KindClaudeCode {
				inputs, err := worker.PendingInputs(ctx, r.engine.store, r.assignment.Session)
				if err != nil {
					r.fail(err)
					return nil
				}
				pending = len(inputs) > 0
			}
			if !pending {
				return nil
			}
			completed = event.Event{}
		}
		select {
		case fact, ok := <-facts:
			if !ok {
				return abort(io.ErrUnexpectedEOF)
			}
			accept(fact)
			if fact.Type == loop.TurnFinished {
				completed = fact
			}
		case <-ticker.C:
			if !recorded || awaiting || !r.assignment.LeaderTurn.AcceptsInput() {
				continue
			}
			steering = r.scheduler.PollEvents()
			if len(steering) == 0 {
				steering = nil
				continue
			}
			steer := r.digest.Render(steering)
			cause, awaiting = steer.Cause, true
			if err := r.run.Send(ctx, steer); err != nil {
				return abort(err)
			}
		case <-ctx.Done():
			return abort(context.Cause(ctx))
		}
	}
}

func (r *externalLeader) sendInput(ctx context.Context, input loop.Input) error {
	if r.run != nil {
		return r.run.Send(ctx, input)
	}
	var text strings.Builder
	if r.initial != "" {
		text.WriteString(r.initial)
		text.WriteString("\n\n")
	}
	for _, part := range input.Parts {
		text.WriteString(part.Text)
		text.WriteByte('\n')
	}
	r.assignment.Packet, r.assignment.Cause = text.String(), input.Cause
	r.assignment.Sources = input.Sources
	run, err := r.engine.StartWorker(ctx, r.profile, r.assignment)
	if err == nil {
		r.run = run
		r.done = make(chan struct{})
		go func() {
			defer close(r.done)
			_, err := run.Wait(context.Background())
			if ctx.Err() == nil {
				if err == nil {
					err = io.ErrUnexpectedEOF
				}
				r.fail(err)
			}
		}()
	}
	if err != nil {
		return err
	}
	return nil
}

func (r *externalLeader) Close() {
	if r.run != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = r.run.Cancel(ctx)
		<-r.done
	}
	_ = r.endpoint.Close()
}
