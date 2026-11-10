// Package loop runs a conversation turn against a model provider.
package loop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

const (
	TurnStarted   event.Type = "turn.started"
	TurnFinished  event.Type = "turn.finished"
	TurnPreempted event.Type = "turn.preempted"
)

func init() {
	event.Register[session.Started](TurnStarted)
	event.Register[Outcome](TurnFinished)
	event.Register[Preempted](TurnPreempted)
}

type Preempted struct {
	Causes []event.ID `json:"causes"`
}

type StopReason string

const Answered StopReason = "answered"

const (
	Cancelled    StopReason = "cancelled"
	Failed       StopReason = "failed"
	MaxSteps     StopReason = "maxSteps"
	MaxTokens    StopReason = "maxTokens"
	MaxCost      StopReason = "maxCost"
	MaxWallClock StopReason = "maxWallClock"
)

type Limits = session.Budget

var errWallClock = errors.New("worker wall clock budget exhausted")

func BudgetStop(reason StopReason) bool {
	return reason == MaxSteps || reason == MaxTokens || reason == MaxCost || reason == MaxWallClock
}

type Loop struct {
	Limits   Limits
	Budget   func(context.Context) (StopReason, error)
	Deadline func(context.Context) (time.Time, error)
	Finish   func() []model.Part
	Steer    Steer
	Model    model.Provider
	ModelID  string
	Thinking model.Thinking
	Bus      *event.Bus
	Tools    *tool.Pool
	Env      tool.Env
	Snapshot func(context.Context, *session.State) error
	Window   *window.Builder
}

type Input struct {
	ExtendBudget bool
	Sources      []event.ID
	Selection    *session.Selection
	Parts        []model.Part
	Actor        event.Actor
	Cause        event.ID
	Child        *session.ChildResult
}

type Steer interface {
	Poll() []Input
	Preempt() <-chan struct{}
}

type Outcome struct {
	Stop  StopReason   `json:"stop"`
	Final []model.Part `json:"final,omitempty"`
	Usage model.Usage  `json:"usage"`
	Code  string       `json:"code,omitempty"`
}

func (l *Loop) RunTurn(ctx context.Context, s *session.State, in Input) (outcome Outcome, runErr error) {
	scope := s.Scope
	scope.Session = s.ID
	scope.Turn = ""
	started, err := l.emit(ctx, s, scope, in.Actor, TurnStarted, session.Started{Selection: in.Selection}, "")
	if err != nil {
		return Outcome{}, err
	}
	if l.Limits.MaxWallClock > 0 {
		deadline := s.Config.BudgetDeadline
		if deadline.IsZero() {
			deadline = time.Now().Add(l.Limits.MaxWallClock)
		}
		var cancel context.CancelFunc
		ctx, cancel = l.wallClock(ctx, deadline)
		defer cancel()
	}
	scope.Turn = started.ID
	var usage model.Usage
	defer func() {
		if runErr == nil {
			return
		}
		outcome = Outcome{Stop: Failed, Usage: usage, Code: "MRK-2001"}
		if runErr.Error() == "MRK-4002" || runErr.Error() == "MRK-4003" {
			outcome.Code = runErr.Error()
		}
		if errors.Is(runErr, context.Canceled) || errors.Is(runErr, context.DeadlineExceeded) {
			outcome.Stop = Cancelled
			outcome.Code = ""
		}
		if errors.Is(context.Cause(ctx), errWallClock) {
			outcome.Stop = MaxWallClock
			outcome.Code = "MRK-4005"
			runErr = nil
		}
		_ = session.CloseInterruptedCalls(context.WithoutCancel(ctx), l.Bus, s)
		_, _ = l.emit(context.WithoutCancel(ctx), s, scope, event.Actor{Kind: event.ActorAgent}, TurnFinished, outcome, "")
	}()
	if err := l.Inject(ctx, s, []Input{in}); err != nil {
		return Outcome{}, err
	}
	var specs []model.ToolSpec
	toolSpecs := s.Tools
	if toolSpecs == nil {
		toolSpecs = l.Tools.Specs()
	}
	for _, spec := range toolSpecs {
		specs = append(specs, model.ToolSpec{Name: spec.Name, Description: spec.Description, Input: spec.Input})
	}
	agent := event.Actor{Kind: event.ActorAgent}
	for step := 0; ; step++ {
		stop, err := l.limit(ctx, s, step)
		if err != nil {
			return Outcome{}, err
		}
		if stop != "" {
			outcome := Outcome{Stop: stop, Usage: usage, Code: "MRK-4005"}
			_, err := l.emit(ctx, s, scope, agent, TurnFinished, outcome, "")
			return outcome, err
		}
		if l.Steer != nil {
			if err := l.Inject(ctx, s, l.Steer.Poll()); err != nil {
				return Outcome{}, err
			}
		}
		request := model.Request{Model: l.ModelID, Thinking: l.Thinking, System: s.System, Messages: s.Messages, Tools: specs}
		if l.Window != nil {
			var err error
			request, err = l.Window.Build(ctx, s)
			usage = usage.Add(l.Window.SummaryUsage)
			if err != nil {
				return Outcome{}, err
			}
		}
		message, err := l.askStep(ctx, s, scope, request)
		if err != nil {
			usage = usage.Add(message.Usage)
			if len(message.Parts) > 0 || message.Usage.Input > 0 || message.Usage.Output > 0 {
				_, _ = l.emit(context.WithoutCancel(ctx), s, scope, agent, session.MessageCompleted, message, "")
			}
			if errors.Is(err, errPreempted) && ctx.Err() == nil {
				if err := session.CloseInterruptedCalls(ctx, l.Bus, s); err != nil {
					return Outcome{}, err
				}
				inputs := l.Steer.Poll()
				value := Preempted{}
				for _, input := range inputs {
					if input.Cause != "" {
						value.Causes = append(value.Causes, input.Cause)
					}
				}
				var cause event.ID
				if len(value.Causes) > 0 {
					cause = value.Causes[0]
				}
				if _, err := l.emit(ctx, s, scope, agent, TurnPreempted, value, cause); err != nil {
					return Outcome{}, err
				}
				if err := l.Inject(ctx, s, inputs); err != nil {
					return Outcome{}, err
				}
				continue
			}
			return Outcome{}, err
		}
		if l.Window != nil {
			l.Window.Observe(s.Config.Provider, request, message.Usage)
		}
		if _, err := l.emit(ctx, s, scope, agent, session.MessageCompleted, message, ""); err != nil {
			return Outcome{}, err
		}
		usage = usage.Add(message.Usage)
		stop, err = l.limit(ctx, s, 0)
		if err != nil {
			return Outcome{}, err
		}
		if stop != "" {
			if err := session.CloseInterruptedCalls(ctx, l.Bus, s); err != nil {
				return Outcome{}, err
			}
			outcome := Outcome{Stop: stop, Usage: usage, Final: message.Parts, Code: "MRK-4005"}
			_, err := l.emit(ctx, s, scope, agent, TurnFinished, outcome, "")
			return outcome, err
		}
		var calls []model.ToolCall
		for _, part := range message.Parts {
			if part.ToolCall != nil {
				calls = append(calls, *part.ToolCall)
			}
		}
		if len(calls) == 0 {
			if l.Steer != nil {
				inputs := l.Steer.Poll()
				if len(inputs) > 0 {
					if err := l.Inject(ctx, s, inputs); err != nil {
						return Outcome{}, err
					}
					continue
				}
			}
			outcome := Outcome{Stop: Answered, Final: message.Parts, Usage: usage}
			_, err = l.emit(ctx, s, scope, agent, TurnFinished, outcome, "")
			return outcome, err
		}
		if err := l.runTools(ctx, s, scope, calls); err != nil {
			return Outcome{}, err
		}
		if l.Finish != nil {
			if final := l.Finish(); final != nil {
				outcome := Outcome{Stop: Answered, Final: final, Usage: usage}
				_, err := l.emit(ctx, s, scope, agent, TurnFinished, outcome, "")
				return outcome, err
			}
		}
	}
}

func (l *Loop) limit(ctx context.Context, s *session.State, steps int) (StopReason, error) {
	if l.Limits.MaxSteps > 0 && steps >= l.Limits.MaxSteps {
		return MaxSteps, nil
	}
	if l.Limits.MaxTokens > 0 && s.Usage.Input+s.Usage.Output >= l.Limits.MaxTokens {
		return MaxTokens, nil
	}
	if l.Limits.MaxCost > 0 && s.Usage.CostKnown && s.Usage.Cost >= l.Limits.MaxCost {
		return MaxCost, nil
	}
	if l.Budget != nil {
		return l.Budget(ctx)
	}
	return "", nil
}

func (l *Loop) runTools(ctx context.Context, s *session.State, scope event.Scope, calls []model.ToolCall) error {
	agent := event.Actor{Kind: event.ActorAgent}
	for start := 0; start < len(calls); {
		end := start + 1
		if l.isRead(calls[start].Name) {
			for end < len(calls) && l.isRead(calls[end].Name) {
				end++
			}
		}
		group := calls[start:end]
		causes := make([]event.ID, len(group))
		for i, call := range group {
			called, err := l.emit(ctx, s, scope, agent, tool.Called, call, "")
			if err != nil {
				return err
			}
			causes[i] = called.ID
		}
		results := make([]tool.Result, len(group))
		errors := make([]error, len(group))
		var workers sync.WaitGroup
		for i, call := range group {
			workers.Go(func() { results[i], errors[i] = l.execute(ctx, scope, call) })
		}
		workers.Wait()
		for i, call := range group {
			if errors[i] != nil {
				return errors[i]
			}
			if results[i].ChildID != "" {
				if _, err := l.emit(ctx, s, scope, agent, session.ChildStarted, session.ChildResult{ID: results[i].ChildID}, causes[i]); err != nil {
					return err
				}
			}
			if _, err := l.emit(ctx, s, scope, agent, tool.Completed, tool.Completion{CallID: call.ID, Name: call.Name, Result: results[i]}, causes[i]); err != nil {
				return err
			}
		}
		start = end
	}
	return nil
}

func (l *Loop) Inject(ctx context.Context, s *session.State, inputs []Input) error {
	for _, input := range inputs {
		if input.Child != nil {
			if s.Children[input.Child.ID].Delivered {
				continue
			}
			if _, err := l.emit(ctx, s, s.Scope, input.Actor, session.ChildFinished, input.Child, input.Cause); err != nil {
				return err
			}
			continue
		}
		if _, err := l.emit(ctx, s, s.Scope, input.Actor, session.MessageSent, session.Input{Message: model.Message{Role: model.User, Parts: input.Parts}, Sources: input.Sources}, input.Cause); err != nil {
			return err
		}
	}
	return nil
}

func (l *Loop) isRead(name string) bool {
	t, ok := l.Tools.Lookup(name)
	return ok && t.Spec().Effect == tool.EffectRead
}

func (l *Loop) ask(ctx context.Context, s *session.State, scope event.Scope, req model.Request) (completion session.Completion, runErr error) {
	stream, err := l.Model.Stream(ctx, req)
	if err != nil {
		return session.Completion{}, err
	}
	defer stream.Close()
	var collector model.Collector
	defer func() {
		message, usage, _ := collector.Message()
		if runErr != nil {
			parts := make([]model.Part, 0, len(message.Parts))
			for _, part := range message.Parts {
				if part.ToolCall != nil && !json.Valid(part.ToolCall.Input) {
					continue
				}
				parts = append(parts, part)
			}
			message.Parts = parts
		}
		completion = session.Completion{Message: message, Usage: usage, Interrupted: runErr != nil, Dropped: collector.Dropped()}
	}()
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return session.Completion{}, err
		}
		collector.Add(chunk)
		if _, err := l.emit(ctx, s, scope, event.Actor{Kind: event.ActorAgent}, session.MessageDelta, chunk, ""); err != nil {
			return session.Completion{}, err
		}
	}
	message, usage, _ := collector.Message()
	return session.Completion{Message: message, Usage: usage}, nil
}

func (l *Loop) execute(ctx context.Context, scope event.Scope, call model.ToolCall) (tool.Result, error) {
	if !json.Valid(call.Input) {
		return tool.Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: "Tool arguments are not valid JSON."}}}, nil
	}
	env := l.Env
	env.Scope = scope
	if t, ok := l.Tools.Lookup(call.Name); ok {
		return tool.Execute(ctx, t, tool.Call{ID: call.ID, Name: call.Name, Input: call.Input, Env: env})
	}
	return tool.Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: "Unknown tool: " + call.Name}}}, nil
}

func (l *Loop) emit(ctx context.Context, s *session.State, scope event.Scope, actor event.Actor, kind event.Type, payload any, cause event.ID) (event.Event, error) {
	if actor.Kind == event.ActorAgent && actor.ID == "" {
		actor.ID = s.Config.Member
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return event.Event{}, err
	}
	e, err := l.Bus.Publish(ctx, event.Event{
		Stream: event.Stream("session:" + string(s.ID)), Type: kind,
		Scope: scope, Actor: actor, Payload: data, Cause: cause,
	})
	if err != nil {
		return e, err
	}
	if err := session.Fold(s, e); err != nil {
		return e, err
	}
	if e.Seq != 0 && e.Seq%128 == 0 && l.Snapshot != nil {
		if err := l.Snapshot(ctx, s); err != nil {
			return e, err
		}
	}
	return e, nil
}
