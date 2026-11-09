package engine

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/window"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
)

type SessionOptions struct {
	Mode     permission.Mode
	ID       event.ID
	Scope    event.Scope
	Role     string
	Member   event.ID
	System   string
	ToolPool string
	Parent   event.ID
	Provider string
	Model    string
	Thinking model.Thinking
	Workdir  string
}

type conversation struct {
	suppressChildren bool
	children         *builtin.Runner
	memoryCancel     context.CancelFunc
	state            *session.State
	runner           loop.Loop
	queue            chan *conversationTurn
	turns            map[*conversationTurn]struct{}
}

type conversationTurn struct {
	selection *session.Selection
	ctx       context.Context
	cancel    context.CancelFunc
	parts     []model.Part
}

func (e *Engine) CreateSession(ctx context.Context, options SessionOptions) (event.ID, error) {
	if e.storageFull() {
		return "", store.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	c, err := e.newConversation(ctx, options)
	if err != nil {
		return "", err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ctx.Err() != nil {
		c.runner.Env.Jobs.Close()
		return "", errors.New("MRK-4001")
	}
	c.state, err = e.manager.Create(ctx, *c.state)
	if err != nil {
		c.runner.Env.Jobs.Close()
		return "", err
	}
	e.startConversation(c)
	return c.state.ID, nil
}

func (e *Engine) startConversation(c *conversation) {
	e.sessions[c.state.ID] = c
	e.workers.Go(func() {
		defer e.releaseSandbox(c.state.ID)
		defer c.runner.Env.Jobs.Close()
		var childrenReady <-chan struct{}
		if c.children != nil {
			defer c.children.Close()
			childrenReady = c.children.Ready()
		}
		timer := time.NewTimer(time.Hour)
		timer.Stop()
		defer timer.Stop()
		var idle <-chan time.Time
		for {
			select {
			case <-e.ctx.Done():
				return
			case <-childrenReady:
				for _, input := range c.children.Poll() {
					if input.Child != nil && c.state.Children[input.Child.ID].Delivered {
						continue
					}
					e.mu.Lock()
					suppressed := c.suppressChildren
					childCtx, cancel := context.WithCancel(e.ctx)
					turn := &conversationTurn{ctx: childCtx, cancel: cancel}
					c.turns[turn] = struct{}{}
					e.mu.Unlock()
					if suppressed {
						_ = c.runner.Inject(childCtx, c.state, []loop.Input{input})
						_ = e.manager.Snapshot(childCtx, c.state)
					} else {
						_, _ = e.runInput(childCtx, c, input)
					}
					cancel()
					e.mu.Lock()
					delete(c.turns, turn)
					e.mu.Unlock()
				}
			case <-idle:
				idle = nil
				e.extractMemory(c)
			case turn := <-c.queue:
				timer.Stop()
				idle = nil
				outcome, err := e.runInput(turn.ctx, c, loop.Input{Parts: turn.parts, Actor: event.Actor{Kind: event.ActorHuman}, Selection: turn.selection})
				turn.cancel()
				e.mu.Lock()
				delete(c.turns, turn)
				e.mu.Unlock()
				if err == nil && outcome.Stop == loop.Answered {
					timer.Reset(e.memoryIdle)
					idle = timer.C
				}
			}
		}
	})
}

func (e *Engine) Cancel(id event.ID) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.sessions[id]
	if c == nil {
		return errors.New("MRK-4001")
	}
	for turn := range c.turns {
		turn.cancel()
	}
	c.suppressChildren = true
	if c.children != nil {
		c.children.Cancel()
	}
	if c.memoryCancel != nil {
		c.memoryCancel()
	}
	return nil
}

func (e *Engine) Send(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	var selected *session.Selection
	if len(selections) > 1 {
		return errors.New("MRK-4001")
	}
	if len(selections) == 1 {
		value := selections[0]
		if value.Model == "" || e.provider(value.Provider) == nil {
			return errors.New("MRK-4001")
		}
		switch value.Thinking {
		case "", model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax:
		default:
			return errors.New("MRK-4001")
		}
		selected = &value
	}
	if e.storageFull() {
		return store.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(parts) == 0 {
		return errors.New("MRK-4001")
	}
	body, err := json.Marshal(parts)
	if err != nil {
		return errors.New("MRK-4001")
	}
	var copy []model.Part
	if err := json.Unmarshal(body, &copy); err != nil {
		return errors.New("MRK-4001")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.sessions[id]
	if e.ctx.Err() != nil {
		return errors.New("MRK-4001")
	}
	if c == nil {
		state, err := e.manager.Load(ctx, id)
		if err != nil {
			return err
		}
		if err := e.manager.Reconcile(ctx, state); err != nil {
			return err
		}
		c, err = e.conversationFor(state)
		if err != nil {
			return err
		}
		e.startConversation(c)
	}
	turnCtx, cancel := context.WithCancel(e.ctx)
	turn := &conversationTurn{ctx: turnCtx, cancel: cancel, parts: copy, selection: selected}
	select {
	case c.queue <- turn:
		c.suppressChildren = false
		if c.memoryCancel != nil {
			c.memoryCancel()
		}
		c.turns[turn] = struct{}{}
		return nil
	default:
		cancel()
		return errors.New("MRK-4001")
	}
}

func (e *Engine) runConversation(ctx context.Context, c *conversation, parts []model.Part) (loop.Outcome, error) {
	return e.runInput(ctx, c, loop.Input{Parts: parts, Actor: event.Actor{Kind: event.ActorHuman}})
}

func (e *Engine) runInput(ctx context.Context, c *conversation, input loop.Input) (loop.Outcome, error) {
	done := c.runner.Env.Sandbox.Hold()
	defer done()
	selected := session.Selection{Provider: c.state.Config.Provider, Model: c.state.Config.Model, Thinking: c.state.Config.Thinking}
	if input.Selection != nil {
		selected = *input.Selection
	}
	if c.children != nil {
		config := c.state.Config
		config.Provider, config.Model, config.Thinking = selected.Provider, selected.Model, selected.Thinking
		c.children.SetRun(e.childRun(c.state.ID, config))
	}
	provider := e.provider(selected.Provider)
	if provider == nil {
		provider = unavailableProvider(selected.Provider)
	}
	c.runner.Model = provider
	c.runner.Window.Summarize = window.ModelSummarizer{Provider: provider}
	c.runner.ModelID, c.runner.Thinking = selected.Model, selected.Thinking
	parts := input.Parts
	entry := e.catalog.Get(selected.Provider, selected.Model)
	c.runner.Window.Budget.Window = entry.Window
	c.runner.Window.Budget.Reserve = max(entry.MaxOutput/4, 8192)
	if len(c.state.Messages) == 0 && input.Child == nil {
		var text string
		for _, part := range parts {
			text += part.Text + "\n"
		}
		notes, recallErr := e.notes.Recall(ctx, memory.Query{Owners: c.runner.Env.MemoryOwners, Text: text, Limit: 5})
		if recallErr == nil && len(notes) == 0 {
			notes, recallErr = e.notes.Recall(ctx, memory.Query{Owners: c.runner.Env.MemoryOwners, Limit: 5})
		}
		if recallErr == nil && len(notes) > 0 {
			parts = append([]model.Part{{Text: memory.Format(notes)}}, parts...)
		}
		parts = append([]model.Part{{Text: "Current date and time: " + e.now().Format(time.RFC3339)}}, parts...)
	}
	input.Parts = parts
	outcome, err := c.runner.RunTurn(ctx, c.state, input)
	if e.logger != nil {
		logger := platformlog.With(e.logger, c.state.Scope).With("event", string(c.state.Scope.Turn))
		if err != nil {
			logger.Error("turn failed", "code", outcome.Code)
		} else {
			logger.Info("turn finished", "stop", outcome.Stop)
		}
	}
	snapshotCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if snapshotErr := e.manager.Snapshot(snapshotCtx, c.state); snapshotErr != nil && err == nil {
		err = snapshotErr
	}
	return outcome, err
}

type unavailableProvider string

func (p unavailableProvider) Name() string { return string(p) }
func (p unavailableProvider) Stream(context.Context, model.Request) (model.Stream, error) {
	return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("provider is no longer configured")}
}

func (e *Engine) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.Shutdown(ctx)
}
