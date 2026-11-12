package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	slash "github.com/TongTong313/merakcode/merak/engine/command"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/skill"
	"github.com/TongTong313/merakcode/merak/engine/snapshot"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
)

type SessionOptions struct {
	MCPServers map[string]config.MCPServer
	Budget     session.Budget
	Mode       permission.Mode
	ID         event.ID
	Scope      event.Scope
	Role       string
	Member     event.ID
	System     string
	// Tools limits the conversation to these tools of its pool; empty keeps the whole pool.
	Tools []string
	// Switches turn tools off or on by name, on top of the configuration's tools section.
	Switches map[string]bool
	ToolPool string
	// Key is chosen by the client: asking again with the same key returns the conversation it made the first time.
	Key string
	// Agent is the saved agent to talk to; an external product takes over the whole conversation.
	Agent    event.ID
	Parent   event.ID
	Provider string
	Model    string
	Thinking model.Thinking
	Workdir  string
}

type conversation struct {
	mcpServers       map[string]config.MCPServer
	mcpReady         bool
	suppressChildren bool
	titled           bool
	// recommender suggests skills for the messages of this conversation; nil in a conversation of a group or a child.
	recommender *skill.Recommender
	// fromCommand marks the next message as the expansion of a slash command, which already says what it wants.
	fromCommand  bool
	children     *builtin.Runner
	memoryCancel context.CancelFunc
	state        *session.State
	runner       loop.Loop
	queue        chan *conversationTurn
	turns        map[*conversationTurn]struct{}
}

type conversationTurn struct {
	budgetCause  event.ID
	extendBudget bool
	selection    *session.Selection
	ctx          context.Context
	cancel       context.CancelFunc
	parts        []model.Part
}

func (e *Engine) CreateSession(ctx context.Context, options SessionOptions) (event.ID, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if options.Key != "" {
		return e.createKeyed(ctx, options)
	}
	if options.Agent != "" {
		p, err := e.loadAgentByID(ctx, options.Agent)
		if err != nil {
			return "", coded(errorcode.SessionRequestFailed, err)
		}
		if p.Product != nil && p.Product.Kind != worker.KindBuiltin {
			return e.createExternalChat(ctx, p, options)
		}
		if chosen, err := e.memberModel(p.Model); err == nil && options.Provider == "" {
			options.Provider, options.Model, options.Thinking = chosen.Provider, chosen.Model, chosen.Thinking
		}
		options.System += p.System
		if options.Mode == "" {
			options.Mode = p.Mode
		}
	} else if options.Parent == "" {
		e.applyDefaultAgent(&options)
	}
	if options.Provider == "" {
		if fallback := e.defaultModel.Load(); fallback != nil {
			options.Provider, options.Model, options.Thinking = fallback.Provider, fallback.Model, fallback.Thinking
		}
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
				outcome, err := e.runInput(turn.ctx, c, loop.Input{Parts: turn.parts, Actor: event.Actor{Kind: event.ActorHuman}, Selection: turn.selection, ExtendBudget: turn.extendBudget})
				turn.cancel()
				e.mu.Lock()
				delete(c.turns, turn)
				e.mu.Unlock()
				if err == nil && outcome.Stop == loop.Answered {
					e.maybeTitle(c)
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
		if chat := e.externals[id]; chat != nil {
			chat.pending = nil
			if chat.active != nil {
				_ = chat.active.Cancel(e.ctx)
			}
			return nil
		}
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
	return e.SendWithBudget(ctx, id, parts, false, selections...)
}

func (e *Engine) SendWithBudget(ctx context.Context, id event.ID, parts []model.Part, extendBudget bool, selections ...session.Selection) error {
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
		chat, err := e.externalChatOf(ctx, id)
		if err != nil {
			return err
		}
		if chat != nil {
			return e.sendExternal(ctx, id, chat, copy)
		}
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
	var budgetCause event.ID
	if c.state.Config.Budget != (session.Budget{}) || extendBudget {
		facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
		if err != nil {
			return err
		}
		var outcome loop.Outcome
		if len(facts) > 0 {
			outcome, _ = event.Decode[loop.Outcome](facts[len(facts)-1])
			if extendBudget {
				budgetCause = facts[len(facts)-1].ID
			}
		}
		if loop.BudgetStop(outcome.Stop) && !extendBudget || extendBudget && (c.state.Scope.Group != "" || !loop.BudgetStop(outcome.Stop)) {
			return errors.New("MRK-4005")
		}
		if extendBudget {
			for pending := range c.turns {
				if pending.budgetCause == budgetCause {
					return errors.New("MRK-4005")
				}
			}
		}
	}
	turnCtx, cancel := context.WithCancel(e.ctx)
	turn := &conversationTurn{ctx: turnCtx, cancel: cancel, parts: copy, selection: selected, extendBudget: extendBudget, budgetCause: budgetCause}
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
	if input.ExtendBudget {
		body, _ := json.Marshal(c.state.Config.Budget)
		fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + c.state.ID), Scope: c.state.Scope, Type: session.BudgetExtended, Actor: input.Actor, Payload: body})
		if err != nil {
			return loop.Outcome{}, err
		}
		if err := session.Fold(c.state, fact); err != nil {
			return loop.Outcome{}, err
		}
	}
	if err := e.configureExecutionBudget(ctx, c); err != nil {
		return loop.Outcome{}, err
	}
	done := c.runner.Env.Sandbox.Hold()
	defer done()
	e.prepareMCP(ctx, c)
	selected := session.Selection{Provider: c.state.Config.Provider, Model: c.state.Config.Model, Thinking: c.state.Config.Thinking}
	if input.Selection != nil {
		selected = *input.Selection
	}
	if c.children != nil {
		config := c.state.Config
		config.Provider, config.Model, config.Thinking = selected.Provider, selected.Model, selected.Thinking
		c.children.SetRun(e.childRun(c.state.ID, c.state.Scope, config))
	}
	provider := e.provider(selected.Provider)
	if provider == nil {
		provider = unavailableProvider(selected.Provider)
	}
	c.runner.Model = provider
	c.runner.Window.Summarize = e.summarizer(provider)
	c.runner.Window.ManualOnly = e.autoCompactOff.Load()
	c.runner.ModelID, c.runner.Thinking = selected.Model, selected.Thinking
	parts := input.Parts
	entry := e.catalog.Get(selected.Provider, selected.Model)
	c.runner.Window.Budget.Window = entry.Window
	c.runner.Window.Budget.Reserve = max(entry.MaxOutput/4, 8192)
	if len(c.state.Messages) == 0 && input.Child == nil {
		if c.state.Scope.Task == "" || c.state.Config.ToolPool == "leader.default" {
			var text string
			for _, part := range parts {
				text += part.Text + "\n"
			}
			var notes []memory.Note
			var recallErr error
			if e.memoryRecallOn() {
				notes, recallErr = e.notes.Recall(ctx, memory.Query{Owners: c.runner.Env.MemoryOwners, Text: text, Limit: 5})
				if recallErr == nil && len(notes) == 0 {
					notes, recallErr = e.notes.Recall(ctx, memory.Query{Owners: c.runner.Env.MemoryOwners, Limit: 5})
				}
			}
			if recallErr == nil && len(notes) > 0 {
				parts = append([]model.Part{{Text: memory.Format(notes)}}, parts...)
			}
		}
		parts = append([]model.Part{{Text: "Current date and time: " + e.now().Format(time.RFC3339)}}, parts...)
	}
	e.mu.Lock()
	expanded := c.fromCommand && input.Actor.Kind == event.ActorHuman
	if expanded {
		c.fromCommand = false
	}
	e.mu.Unlock()
	if c.recommender != nil && !expanded && input.Actor.Kind == event.ActorHuman && input.Child == nil {
		var typed strings.Builder
		for _, part := range input.Parts {
			typed.WriteString(part.Text + "\n")
		}
		if suggestion := c.recommender.For(typed.String()); suggestion != "" {
			parts = append(parts, model.Part{Text: suggestion})
		}
	}
	input.Parts = parts
	outcome, err := c.runner.RunTurn(ctx, c.state, input)
	if loop.BudgetStop(outcome.Stop) {
		e.blockBudgetTask(context.WithoutCancel(ctx), c.state.Scope)
	}
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

// openSession returns the live conversation of a session, loading it from the store when it is not running.
// The caller holds e.mu.
func (e *Engine) openSession(ctx context.Context, id event.ID) (*conversation, error) {
	if c := e.sessions[id]; c != nil {
		return c, nil
	}
	state, err := e.manager.Load(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := e.manager.Reconcile(ctx, state); err != nil {
		return nil, err
	}
	c, err := e.conversationFor(state)
	if err != nil {
		return nil, err
	}
	e.startConversation(c)
	return c, nil
}

// publishSession records a change of a session and folds it into the live state. The caller holds e.mu.
func (e *Engine) publishSession(ctx context.Context, c *conversation, kind event.Type, payload any) (event.Event, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return event.Event{}, err
	}
	scope := c.state.Scope
	scope.Session = c.state.ID
	fact, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + c.state.ID), Scope: scope, Type: kind, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
	if err != nil {
		return event.Event{}, err
	}
	return fact, session.Fold(c.state, fact)
}

// UpdateSession changes the title, the archive state or the permission mode of a session. A mode change applies
// to the next turn and cannot happen while a turn runs; takeover needs an explicit confirmation.
func (e *Engine) UpdateSession(ctx context.Context, id event.ID, update session.Update) error {
	if update.Mode != "" {
		e.waitIdle(ctx, id)
	}
	if update.Mode != "" && update.Mode != permission.ModeAsk && update.Mode != permission.ModeAuto && update.Mode != permission.ModeTakeover {
		return coded(errorcode.SessionRequestFailed, errors.New("unknown permission mode"))
	}
	if update.Mode == permission.ModeTakeover && !update.Confirm {
		return coded(errorcode.TakeoverNeedsConfirmation, errors.New("takeover needs confirmation"))
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	c, err := e.openSession(ctx, id)
	if err != nil {
		return err
	}
	if update.Mode != "" && len(c.turns) > 0 {
		return coded(errorcode.SessionBusy, errors.New("the mode changes between turns"))
	}
	if _, err := e.publishSession(ctx, c, session.Updated, session.Change{Title: update.Title, Archived: update.Archived, Mode: update.Mode}); err != nil {
		return err
	}
	if update.Mode != "" {
		c.runner.Env.Mode = string(update.Mode)
		c.runner.Env.Sandbox.Disabled = update.Mode == permission.ModeTakeover
	}
	return e.manager.Snapshot(ctx, c.state)
}

// snapshotRepo is the shadow repository of a session's workspace.
func (e *Engine) snapshotRepo(id event.ID, workdir string) (snapshot.Repo, error) {
	e.snapshotMu.Lock()
	defer e.snapshotMu.Unlock()
	if e.snapshotDir == "" {
		if e.dataDir != "" {
			e.snapshotDir = filepath.Join(e.dataDir, "snapshots")
		} else {
			dir, err := os.MkdirTemp("", "merak-snapshots-")
			if err != nil {
				return snapshot.Repo{}, err
			}
			e.snapshotDir, e.snapshotTemp = dir, true
		}
	}
	return snapshot.Repo{GitDir: filepath.Join(e.snapshotDir, string(id)), Workdir: workdir}, nil
}

func (e *Engine) trackWorkspace(id event.ID, workdir string) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		if !e.snapshotsEnabled() {
			return "", nil
		}
		repo, err := e.snapshotRepo(id, workdir)
		if err != nil {
			return "", err
		}
		return repo.Track(ctx)
	}
}

// RevertSession hides a message of the user and everything after it and puts the files that those turns
// changed, whichever tool changed them, back the way they were before the message.
func (e *Engine) RevertSession(ctx context.Context, id, message event.ID) error {
	e.waitIdle(ctx, id)
	e.mu.Lock()
	defer e.mu.Unlock()
	c, err := e.openSession(ctx, id)
	if err != nil {
		return err
	}
	if len(c.turns) > 0 {
		return coded(errorcode.SessionBusy, errors.New("revert between turns"))
	}
	mark, ok := c.state.MarkOf(message)
	if !ok {
		return coded(errorcode.RevertTargetInvalid, errors.New("not a visible message of this session"))
	}
	revert := session.Revert{Message: message}
	if tree := c.state.RestoreTree(mark.Index); tree != "" && e.snapshotsEnabled() {
		repo, err := e.snapshotRepo(id, c.state.Config.Workdir)
		if err != nil {
			return err
		}
		if revert.Current, err = repo.Track(ctx); err != nil {
			return err
		}
		if err := repo.Restore(ctx, tree); err != nil {
			return err
		}
		revert.Restored = tree
	}
	if _, err := e.publishSession(ctx, c, session.Reverted, revert); err != nil {
		return err
	}
	return e.manager.Snapshot(ctx, c.state)
}

// UnrevertSession brings back what the last revert hid, unless a message was sent since.
func (e *Engine) UnrevertSession(ctx context.Context, id event.ID) error {
	e.waitIdle(ctx, id)
	e.mu.Lock()
	defer e.mu.Unlock()
	c, err := e.openSession(ctx, id)
	if err != nil {
		return err
	}
	if len(c.turns) > 0 {
		return coded(errorcode.SessionBusy, errors.New("unrevert between turns"))
	}
	if c.state.Hidden == nil {
		return coded(errorcode.NothingToRestore, errors.New("nothing was reverted"))
	}
	if tree := c.state.Hidden.Current; tree != "" && e.snapshotsEnabled() {
		repo, err := e.snapshotRepo(id, c.state.Config.Workdir)
		if err != nil {
			return err
		}
		if err := repo.Restore(ctx, tree); err != nil {
			return err
		}
	}
	if _, err := e.publishSession(ctx, c, session.Unreverted, struct{}{}); err != nil {
		return err
	}
	return e.manager.Snapshot(ctx, c.state)
}

func (e *Engine) snapshotsEnabled() bool { return !e.snapshotsOff.Load() }

// waitIdle gives a turn that has just finished a moment to leave the engine's books, so a client that acts the
// instant it sees turn.finished is not told the session is busy.
func (e *Engine) waitIdle(ctx context.Context, id event.ID) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		c := e.sessions[id]
		idle := c == nil || len(c.turns) == 0
		e.mu.Unlock()
		if idle || ctx.Err() != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// CompactSession rebuilds the context of a session now, keeping its latest turn, without waiting for the
// context to fill up.
func (e *Engine) CompactSession(ctx context.Context, id event.ID) error {
	e.waitIdle(ctx, id)
	e.mu.Lock()
	c, err := e.openSession(ctx, id)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	if len(c.turns) > 0 {
		e.mu.Unlock()
		return coded(errorcode.SessionBusy, errors.New("compact between turns"))
	}
	turnCtx, cancel := context.WithCancel(e.ctx)
	turn := &conversationTurn{ctx: turnCtx, cancel: cancel}
	c.turns[turn] = struct{}{}
	e.mu.Unlock()
	defer func() {
		cancel()
		e.mu.Lock()
		delete(c.turns, turn)
		e.mu.Unlock()
	}()
	selected := c.state.Config
	provider := e.provider(selected.Provider)
	if provider == nil {
		return coded(errorcode.ContextRebuildFailed, errors.New("the provider is not configured"))
	}
	c.runner.Window.Summarize = e.summarizer(provider)
	entry := e.catalog.Get(selected.Provider, selected.Model)
	c.runner.Window.Budget.Window = entry.Window
	c.runner.Window.Budget.Reserve = max(entry.MaxOutput/4, 8192)
	if err := c.runner.Window.Compact(ctx, c.state); err != nil {
		return coded(errorcode.ContextRebuildFailed, err)
	}
	return e.manager.Snapshot(ctx, c.state)
}

// DeleteSession removes a conversation and the children it started for good: its events, its snapshot and the
// record of its files. The project's files are not touched.
func (e *Engine) DeleteSession(ctx context.Context, id event.ID) error {
	e.waitIdle(ctx, id)
	e.mu.Lock()
	c, err := e.openSession(ctx, id)
	if err != nil {
		e.mu.Unlock()
		return err
	}
	if c.state.Scope.Group != "" {
		e.mu.Unlock()
		return coded(errorcode.SessionRequestFailed, errors.New("the conversation of a group is deleted with the group"))
	}
	if len(c.turns) > 0 {
		e.mu.Unlock()
		return coded(errorcode.SessionBusy, errors.New("delete between turns"))
	}
	delete(e.sessions, id)
	e.mu.Unlock()
	removed, err := e.manager.Delete(ctx, id)
	if err != nil {
		return err
	}
	for _, victim := range removed {
		if repo, err := e.snapshotRepo(victim, ""); err == nil {
			_ = os.RemoveAll(repo.GitDir)
		}
	}
	return nil
}

// maybeTitle names a conversation after its first answer, with the small model. A title the user set meanwhile
// is never replaced, and nothing happens when no model is configured for small jobs.
func (e *Engine) maybeTitle(c *conversation) {
	e.mu.Lock()
	skip := c.titled || c.state.Title != "" || c.state.Scope.Group != "" || c.state.Config.Parent != ""
	c.titled = true
	e.mu.Unlock()
	ref, ok := e.jobModel("title")
	provider := e.provider(ref.Provider)
	if skip || !ok || provider == nil {
		return
	}
	var first, answer strings.Builder
	e.mu.Lock()
	for _, message := range c.state.Messages {
		target := &first
		if message.Role == model.Assistant {
			target = &answer
		} else if message.Role != model.User {
			continue
		}
		for _, part := range message.Parts {
			if part.Text != "" && !strings.HasPrefix(part.Text, "Current date and time:") && target.Len() < 2000 {
				target.WriteString(part.Text + "\n")
			}
		}
		if first.Len() > 0 && answer.Len() > 0 {
			break
		}
	}
	e.mu.Unlock()
	e.workers.Go(func() {
		ctx, cancel := context.WithTimeout(e.ctx, 30*time.Second)
		defer cancel()
		request := model.Request{Model: ref.Model, MaxTokens: 60, System: "Write a title of at most 50 characters for the conversation below, in the language of the user. Reply with the title only: no quotes, no punctuation at the end.", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "User:\n" + first.String() + "\nAssistant:\n" + answer.String()}}}}}
		stream, err := provider.Stream(ctx, request)
		if err != nil {
			return
		}
		defer stream.Close()
		var collector model.Collector
		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				break
			}
			if err != nil {
				return
			}
			collector.Add(chunk)
		}
		message, _, _ := collector.Message()
		var text strings.Builder
		for _, part := range message.Parts {
			text.WriteString(part.Text)
		}
		title := cleanTitle(text.String())
		if title == "" {
			return
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		if c.state.Title != "" || e.sessions[c.state.ID] != c {
			return
		}
		if _, err := e.publishSession(ctx, c, session.Updated, session.Change{Title: &title}); err == nil {
			_ = e.manager.Snapshot(ctx, c.state)
		}
	})
}

// cleanTitle keeps the first line of a model's answer without quotes or closing punctuation, at most 50 characters.
func cleanTitle(text string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	line = strings.Trim(strings.TrimSpace(line), "\"'`“”‘’「」 ")
	line = strings.TrimRight(line, ".。!！?？,，;；:：")
	if runes := []rune(line); len(runes) > 50 {
		line = strings.TrimSpace(string(runes[:50]))
	}
	return line
}

// PruneSessions deletes the top-level conversations that saw no event for storage.retention_days days and
// returns how many it removed. Nothing is deleted while the setting is 0.
func (e *Engine) PruneSessions(ctx context.Context) (int, error) {
	days := int(e.retentionDays.Load())
	if days <= 0 {
		return 0, nil
	}
	cutoff := e.now().Add(-time.Duration(days) * 24 * time.Hour)
	recent, err := e.store.Find(ctx, store.Query{After: cutoff})
	if err != nil {
		return 0, err
	}
	active := make(map[event.ID]bool)
	for _, fact := range recent {
		active[fact.Scope.Session] = true
	}
	infos, err := e.manager.List(ctx)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, info := range infos {
		if info.Config.Parent != "" || info.Config.Member != "" || active[info.ID] || info.CreatedAt.After(cutoff) {
			continue
		}
		if err := e.DeleteSession(ctx, info.ID); err != nil {
			continue
		}
		removed++
	}
	return removed, nil
}

// pruneDaily removes conversations past their retention once a day, starting shortly after the engine starts.
func (e *Engine) pruneDaily() {
	timer := time.NewTimer(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-timer.C:
			_, _ = e.PruneSessions(e.ctx)
			timer.Reset(24 * time.Hour)
		}
	}
}

// externalChat is a conversation driven by an external product: the engine keeps who it talks to, and every
// message starts a run of that product in the same session. A product that takes messages mid-run gets them
// in its running process; the others get one run after the other.
type externalChat struct {
	Agent   event.ID        `json:"agent"`
	Workdir string          `json:"workdir"`
	Mode    permission.Mode `json:"mode,omitempty"`

	pending []string
	steered []steeredInput
	active  worker.Run
	running bool
}

const externalChatKind = "chat-agent"

// createExternalChat records a conversation with an external product; its session starts with the first message.
func (e *Engine) createExternalChat(ctx context.Context, p agent.Agent, options SessionOptions) (event.ID, error) {
	if err := workspace.Existing(options.Workdir); err != nil {
		return "", coded(errorcode.WorkspaceInvalid, err)
	}
	chat := externalChat{Agent: p.ID, Workdir: options.Workdir, Mode: options.Mode}
	if chat.Mode == "" {
		chat.Mode = p.Mode
	}
	body, err := json.Marshal(chat)
	if err != nil {
		return "", err
	}
	id := e.newID()
	if err := e.store.Put(ctx, store.Doc{Kind: externalChatKind, Key: string(id), Body: body}); err != nil {
		return "", err
	}
	return id, nil
}

// externalChatOf returns the external conversation of an id, or nil when it is an engine conversation. The
// caller holds e.mu.
func (e *Engine) externalChatOf(ctx context.Context, id event.ID) (*externalChat, error) {
	if chat := e.externals[id]; chat != nil {
		return chat, nil
	}
	doc, err := e.store.Fetch(ctx, externalChatKind, string(id))
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	chat := new(externalChat)
	if err := json.Unmarshal(doc.Body, chat); err != nil {
		return nil, err
	}
	e.externals[id] = chat
	return chat, nil
}

// sendExternal hands a message to the product of an external conversation. The caller holds e.mu.
func (e *Engine) sendExternal(ctx context.Context, id event.ID, chat *externalChat, parts []model.Part) error {
	var text strings.Builder
	for _, part := range parts {
		text.WriteString(part.Text)
	}
	if strings.TrimSpace(text.String()) == "" {
		return coded(errorcode.SessionRequestFailed, errors.New("an external conversation takes text"))
	}
	if chat.active != nil {
		if p, err := e.loadAgentByID(ctx, chat.Agent); err == nil && e.runnerFor(p, nil).Caps().Steer {
			if chat.active.Send(ctx, loop.Input{Parts: parts, Actor: event.Actor{Kind: event.ActorHuman}}) == nil {
				chat.steered = append(chat.steered, steeredInput{text: text.String(), at: e.now()})
				return nil
			}
		}
	}
	chat.pending = append(chat.pending, text.String())
	if chat.running {
		return nil
	}
	chat.running = true
	e.workers.Go(func() { e.driveExternal(id, chat) })
	return nil
}

// driveExternal runs the queued messages of an external conversation one after the other.
func (e *Engine) driveExternal(id event.ID, chat *externalChat) {
	for {
		e.mu.Lock()
		if len(chat.pending) == 0 || e.ctx.Err() != nil {
			chat.running, chat.active = false, nil
			e.mu.Unlock()
			return
		}
		text := chat.pending[0]
		chat.pending = chat.pending[1:]
		e.mu.Unlock()
		p, err := e.loadAgentByID(e.ctx, chat.Agent)
		if err != nil {
			continue
		}
		run, err := e.StartWorker(e.ctx, p, worker.Assignment{Session: id, Workdir: chat.Workdir, Packet: text, Mode: chat.Mode})
		if err != nil {
			continue
		}
		e.mu.Lock()
		chat.active = run
		e.mu.Unlock()
		_, _ = run.Wait(context.Background())
		e.mu.Lock()
		chat.active = nil
		steered := chat.steered
		chat.steered = nil
		e.mu.Unlock()
		if unseen := e.unseenSteered(e.ctx, id, steered); len(unseen) > 0 {
			e.mu.Lock()
			chat.pending = append(unseen, chat.pending...)
			e.mu.Unlock()
		}
	}
}

// loadAgentByID reads a saved or built-in agent by its id.
func (e *Engine) loadAgentByID(ctx context.Context, id event.ID) (agent.Agent, error) {
	found, _, err := e.loadAgent(ctx, group.Member{Agent: id})
	return found, err
}

// steeredInput is a message pushed into a running product; if the run ends without showing it in the session, it
// goes to the next run.
type steeredInput struct {
	text string
	at   time.Time
}

// unseenSteered returns the steered messages that never appeared as a message of the user in the session.
func (e *Engine) unseenSteered(ctx context.Context, id event.ID, steered []steeredInput) []string {
	var unseen []string
	for _, input := range steered {
		quoted, _ := json.Marshal(input.text)
		facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageSent}, After: input.at.Add(-time.Second), Text: strings.Trim(string(quoted), `"`)})
		if err != nil || len(facts) == 0 {
			unseen = append(unseen, input.text)
		}
	}
	return unseen
}

func cleanTitleTo(text string, limit int) string {
	line, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	line = strings.Trim(strings.TrimSpace(line), "\"'`“”‘’「」 ")
	line = strings.TrimRight(line, ".。!！?？,，;；:：")
	if runes := []rune(line); len(runes) > limit {
		line = strings.TrimSpace(string(runes[:limit]))
	}
	return line
}

const sessionKeyKind = "session-key"

// createKeyed makes a conversation once per client key: a client that lost the response asks again with the same
// key and gets the same conversation.
func (e *Engine) createKeyed(ctx context.Context, options SessionOptions) (event.ID, error) {
	name := string(sha256Key(options.Key))
	e.keyMu.Lock()
	defer e.keyMu.Unlock()
	var stale uint64
	if doc, err := e.store.Fetch(ctx, sessionKeyKind, name); err == nil {
		if _, err := e.SessionSnapshot(ctx, event.ID(doc.Body)); err == nil {
			return event.ID(doc.Body), nil
		}
		stale = doc.Rev // the conversation was deleted since: this key makes a new one
	} else if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}
	options.Key = ""
	id, err := e.CreateSession(ctx, options)
	if err != nil {
		return "", err
	}
	return id, e.store.Put(ctx, store.Doc{Kind: sessionKeyKind, Key: name, Rev: stale, Body: []byte(id)})
}

func sha256Key(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:16])
}

// ConfigureCommands sets the commands of the configuration (the v0.3 command section).
func (e *Engine) ConfigureCommands(entries map[string]slash.Entry) {
	copied := make(map[string]slash.Entry, len(entries))
	for name, entry := range entries {
		copied[name] = entry
	}
	e.commandSet.Store(&copied)
}

func (e *Engine) configuredCommands() map[string]slash.Entry {
	if entries := e.commandSet.Load(); entries != nil {
		return *entries
	}
	return nil
}

// CommandList returns the slash commands that apply to a folder: built-in, configured, from files, one for every
// skill and one for every prompt of the MCP servers that answer.
func (e *Engine) CommandList(ctx context.Context, directory string) ([]slash.Command, error) {
	directory = e.directory(directory)
	skills, err := e.skills(directory)
	if err != nil {
		return nil, err
	}
	global := ""
	if roots := e.skillRoots.Load(); roots != nil {
		global = roots.global
	}
	var prompts []slash.MCPPrompt
	for _, prompt := range e.mcpPrompts(ctx, directory) {
		prompts = append(prompts, prompt)
	}
	return slash.List(directory, global, e.configuredCommands(), skills, prompts)
}

// mcpPrompts asks every enabled MCP server for its prompts; a server that does not answer offers none.
func (e *Engine) mcpPrompts(ctx context.Context, directory string) []slash.MCPPrompt {
	servers := e.mcpDefinitions(ctx, directory)
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	env := tool.Env{Workdir: directory, Sandbox: launcher}
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	found := make([][]slash.MCPPrompt, len(names))
	var wait sync.WaitGroup
	for i, name := range names {
		if servers[name].Disabled {
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			process, err := e.startMCP(ctx, name, servers[name], env)
			if err != nil {
				return
			}
			defer process.Close()
			prompts, err := process.Prompts(ctx)
			if err != nil {
				return
			}
			for _, prompt := range prompts {
				entry := slash.MCPPrompt{Server: name, Name: prompt.Name, Description: prompt.Description}
				for _, argument := range prompt.Arguments {
					entry.Arguments = append(entry.Arguments, argument.Name)
				}
				found[i] = append(found[i], entry)
			}
		}()
	}
	wait.Wait()
	var all []slash.MCPPrompt
	for _, prompts := range found {
		all = append(all, prompts...)
	}
	return all
}

func (e *Engine) startMCP(ctx context.Context, name string, definition config.MCPServer, env tool.Env) (*mcp.Process, error) {
	if definition.Remote() {
		return mcp.StartRemote(ctx, name, definition, e.mcpLogin())
	}
	return mcp.Start(ctx, name, definition, env)
}

// RunCommand runs a slash command in a conversation: it expands the template with the user's words and sends the
// result as the next message. /context is answered by the engine and sends nothing.
func (e *Engine) RunCommand(ctx context.Context, id event.ID, name, arguments string) (slash.Result, error) {
	state, err := e.SessionSnapshot(ctx, id)
	if err != nil {
		return slash.Result{}, err
	}
	list, err := e.CommandList(ctx, state.Config.Workdir)
	if err != nil {
		return slash.Result{}, err
	}
	index := slices.IndexFunc(list, func(c slash.Command) bool { return c.Name == name })
	if index < 0 {
		return slash.Result{}, coded(errorcode.SessionRequestFailed, errors.New("no such command"))
	}
	found := list[index]
	if found.Local {
		return slash.Result{Text: e.contextReport(state)}, nil
	}
	text := found.Expand(arguments)
	if found.Source == slash.MCP {
		if text, err = e.expandPrompt(ctx, state.Config.Workdir, found, arguments); err != nil {
			return slash.Result{}, coded(errorcode.McpStartFailed, err)
		}
	}
	if strings.TrimSpace(text) == "" {
		return slash.Result{}, coded(errorcode.SessionRequestFailed, errors.New("the command has nothing to send"))
	}
	var selection []session.Selection
	if found.Model != "" {
		provider, model, _ := strings.Cut(found.Model, "/")
		selection = append(selection, session.Selection{Provider: provider, Model: model})
	}
	e.mu.Lock()
	if c, err := e.openSession(ctx, id); err == nil {
		c.fromCommand = true
	}
	e.mu.Unlock()
	if err := e.Send(ctx, id, []model.Part{{Text: text}}, selection...); err != nil {
		return slash.Result{}, err
	}
	return slash.Result{Sent: true}, nil
}

func (e *Engine) expandPrompt(ctx context.Context, directory string, found slash.Command, arguments string) (string, error) {
	servers := e.mcpDefinitions(ctx, directory)
	definition, ok := servers[found.Server]
	if !ok || definition.Disabled {
		return "", errors.New("the MCP server of this command is not available")
	}
	launcher := &sandbox.Launcher{Disabled: true}
	launcher.Unavailable = func(context.Context, sandbox.Status) error { return nil }
	process, err := e.startMCP(ctx, found.Server, definition, tool.Env{Workdir: directory, Sandbox: launcher})
	if err != nil {
		return "", err
	}
	defer process.Close()
	values := map[string]string{}
	if len(found.Arguments) > 0 {
		values[found.Arguments[0]] = strings.TrimSpace(arguments)
	}
	return process.GetPrompt(ctx, found.Prompt, values)
}

// contextReport says where the context of a conversation goes: the system prompt, the tools and the messages.
func (e *Engine) contextReport(state session.State) string {
	request := model.Request{Model: state.Config.Model, System: state.System, Messages: state.Messages}
	for _, spec := range state.Tools {
		request.Tools = append(request.Tools, model.ToolSpec{Name: spec.Name, Description: spec.Description, Input: spec.Input})
	}
	estimate := e.counter.Estimate(state.Config.Provider, request)
	entry := e.catalog.Get(state.Config.Provider, state.Config.Model)
	lines := []string{
		"Context of this conversation (estimated tokens):",
		fmt.Sprintf("- System prompt: %d", estimate.System),
		fmt.Sprintf("- Tools (%d): %d", len(state.Tools), estimate.Tools),
		fmt.Sprintf("- Messages (%d): %d", len(state.Messages), estimate.Messages),
		fmt.Sprintf("- Total: %d", estimate.Total),
	}
	if entry.Window > 0 {
		lines = append(lines, fmt.Sprintf("- Window of %s: %d (%d%% used)", state.Config.Model, entry.Window, estimate.Total*100/entry.Window))
	}
	return strings.Join(lines, "\n")
}

// planRoot finds the conversation a plan belongs to: a child reads the plan of its parent.
func (e *Engine) planRoot(ctx context.Context, id event.ID) (event.ID, error) {
	for range 8 {
		state, err := e.SessionSnapshot(ctx, id)
		if err != nil {
			return "", err
		}
		if state.Config.Parent == "" {
			return id, nil
		}
		id = state.Config.Parent
	}
	return "", errors.New("the conversation has no root")
}

func planError(err error) error {
	switch {
	case errors.Is(err, plan.ErrStale):
		return coded(errorcode.PlanStale, err)
	case errors.Is(err, plan.ErrState):
		return coded(errorcode.PlanState, err)
	}
	return err
}

func (e *Engine) announcePlan(ctx context.Context, value plan.Plan) {
	body, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + value.Session), Scope: event.Scope{Session: value.Session}, Type: plan.Updated, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

func (e *Engine) writePlan(ctx context.Context, id event.ID, content string) (plan.Plan, error) {
	written, err := e.plans.Write(ctx, id, content)
	if err == nil {
		e.announcePlan(ctx, written)
	}
	return written, planError(err)
}

// GetPlan returns the plan of a conversation; a child gets the plan of its parent.
func (e *Engine) GetPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	value, err := e.plans.Get(ctx, root)
	return value, planError(err)
}

// SavePlan stores an edit of the plan; the revision is the one the editor started from.
func (e *Engine) SavePlan(ctx context.Context, id event.ID, content string, revision int) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	saved, err := e.plans.Save(ctx, root, content, revision)
	if err == nil {
		e.announcePlan(ctx, saved)
	}
	return saved, planError(err)
}

// ExecutePlan fixes the current plan as the snapshot to run and sends the execution message.
func (e *Engine) ExecutePlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	run, err := e.plans.Execute(ctx, root)
	if err != nil {
		return plan.Plan{}, planError(err)
	}
	e.announcePlan(ctx, run.Plan)
	message := "Execute this plan now. Keep your todo list with todo_write, one item per step, and mark each step done as you finish it.\n\n" + run.Snapshot
	if err := e.Send(ctx, root, []model.Part{{Text: message}}); err != nil {
		return run.Plan, err
	}
	return run.Plan, nil
}

// StopPlan marks a running plan as stopped and stops the conversation's current turn.
func (e *Engine) StopPlan(ctx context.Context, id event.ID) (plan.Plan, error) {
	root, err := e.planRoot(ctx, id)
	if err != nil {
		return plan.Plan{}, err
	}
	stopped, err := e.plans.Stop(ctx, root)
	if err != nil {
		return plan.Plan{}, planError(err)
	}
	e.announcePlan(ctx, stopped)
	_ = e.Cancel(root)
	return stopped, nil
}

// SendPlanned sends a message that first asks for a plan: the agent writes it with write_plan and stops.
func (e *Engine) SendPlanned(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	ask := model.Part{Text: "Before you do anything else, write a plan for the request below by calling write_plan with a Markdown plan, then stop. You may read files to make the plan, but do not change any file and do not run any command that changes anything. The person will review the plan first."}
	return e.Send(ctx, id, append([]model.Part{ask}, parts...), selections...)
}

// todosChanged finishes the plan of a conversation when the model marked every step done.
func (e *Engine) todosChanged(ctx context.Context, id event.ID, items []tool.Todo) {
	if len(items) == 0 {
		return
	}
	for _, item := range items {
		if item.Status != "done" {
			return
		}
	}
	finished, err := e.plans.Finish(context.WithoutCancel(ctx), id)
	if err == nil {
		e.announcePlan(context.WithoutCancel(ctx), finished)
	}
}

// ---- scheduled tasks ----

// SetLocalHuman sets the person the notices of scheduled runs go to; the server passes the identity of its own
// connections.
func (e *Engine) SetLocalHuman(human event.ID) { e.localHuman = human }

// CreateSchedule stores a scheduled task that starts a conversation in a folder each time the cron expression
// names. The agent, when given, is a name or an id from the agent library.
func (e *Engine) CreateSchedule(ctx context.Context, cron, prompt, agentName, workdir string) (schedule.Schedule, error) {
	workdir = e.directory(workdir)
	if err := workspace.Existing(workdir); err != nil {
		return schedule.Schedule{}, coded(errorcode.WorkspaceInvalid, err)
	}
	if agentName != "" {
		if _, found := e.findAgent(ctx, e.localHuman, agentName, workdir); !found {
			return schedule.Schedule{}, coded(errorcode.ScheduleInvalid, fmt.Errorf("no agent is named %s", agentName))
		}
	}
	created, err := e.schedules.Create(ctx, schedule.Schedule{ID: e.newID(), Cron: cron, Prompt: prompt, Agent: agentName, Workdir: workdir, Owner: e.localHuman, Created: e.now()})
	if err != nil {
		return schedule.Schedule{}, coded(errorcode.ScheduleInvalid, err)
	}
	if spec, err := schedule.Parse(created.Cron); err == nil {
		created.Next = spec.Next(e.now())
	}
	return created, nil
}

// ListSchedules returns every scheduled task, oldest first, each with its next run.
func (e *Engine) ListSchedules(ctx context.Context) ([]schedule.Schedule, error) {
	return e.schedules.List(ctx, e.now())
}

// DeleteSchedule removes a scheduled task; it never runs again.
func (e *Engine) DeleteSchedule(ctx context.Context, id event.ID) error {
	if err := e.schedules.Delete(ctx, id); err != nil {
		if errors.Is(err, schedule.ErrNotFound) {
			return coded(errorcode.ScheduleUnknown, err)
		}
		return err
	}
	return nil
}

// CheckSchedules starts the scheduled tasks that became due since the last check. The engine calls it every minute;
// it is public so that a test with its own clock can call it.
func (e *Engine) CheckSchedules(ctx context.Context) error { return e.scheduleRunner.Check(ctx) }

func (e *Engine) watchSchedules(every time.Duration) {
	if every <= 0 {
		every = time.Minute
	}
	if err := e.scheduleRunner.Open(e.ctx); err != nil && e.ctx.Err() == nil && e.logger != nil {
		e.logger.Warn("scheduled tasks could not be read")
	}
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			if err := e.CheckSchedules(e.ctx); err != nil && e.ctx.Err() == nil && e.logger != nil {
				e.logger.Warn("scheduled tasks could not be checked")
			}
		}
	}
}

func (e *Engine) fireSchedule(_ context.Context, s schedule.Schedule) {
	e.workers.Go(func() { e.runSchedule(e.ctx, s) })
}

func (e *Engine) missedSchedule(ctx context.Context, s schedule.Schedule, count int) {
	e.noticeSchedule(ctx, s, "", "schedule-missed", s.Title(), count)
}

// runSchedule starts the conversation of one due run, sends it the prompt and tells the owner how it ended.
func (e *Engine) runSchedule(ctx context.Context, s schedule.Schedule) {
	fail := func(code string) { e.noticeSchedule(ctx, s, "", "blocked", code, 0) }
	options := SessionOptions{Workdir: s.Workdir, Switches: map[string]bool{"schedule_create": false}}
	if s.Agent != "" {
		chosen, found := e.findAgent(ctx, s.Owner, s.Agent, s.Workdir)
		if !found {
			fail(errorcode.ScheduleRunFailed)
			return
		}
		if chosen.Source != "" || strings.HasPrefix(string(chosen.ID), "builtin-") {
			useAgent(&options, chosen)
		} else {
			options.Agent = chosen.ID
		}
	}
	id, err := e.CreateSession(ctx, options)
	if err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	title := s.Title()
	if err := e.UpdateSession(ctx, id, session.Update{Title: &title}); err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	finished, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: s.Prompt}}); err != nil {
		fail(errorcode.ScheduleRunFailed)
		return
	}
	select {
	case fact := <-finished:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err == nil && outcome.Stop == loop.Failed {
			e.noticeSchedule(ctx, s, id, "blocked", outcome.Code, 0)
			return
		}
		e.noticeSchedule(ctx, s, id, "schedule", title, 0)
	case <-ctx.Done():
	}
}

// noticeSchedule puts a notice about a scheduled task into the inbox of its owner.
func (e *Engine) noticeSchedule(ctx context.Context, s schedule.Schedule, conversation event.ID, kind, text string, count int) {
	body, err := json.Marshal(group.Notice{Kind: kind, Text: text, To: []event.ID{s.Owner}, Count: count})
	if err != nil {
		return
	}
	stream := event.Stream("inbox:" + s.Owner)
	e.scheduleNoticeMu.Lock()
	defer e.scheduleNoticeMu.Unlock()
	if err := e.resumeDeviceStream(ctx, stream); err != nil {
		return
	}
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: stream, Scope: event.Scope{Session: conversation}, Type: group.NoticeSent, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
}

// findAgent finds an agent of the library, of a file or of the configuration by name or id.
func (e *Engine) findAgent(ctx context.Context, human event.ID, name, directory string) (agent.Agent, bool) {
	listed, err := e.ListAgentsFor(ctx, human, directory)
	if err != nil {
		return agent.Agent{}, false
	}
	for _, candidate := range listed {
		if candidate.Name == name || string(candidate.ID) == name {
			return candidate, true
		}
	}
	return agent.Agent{}, false
}

// sessionScheduler lets the schedule tools of one conversation act on the schedules of its folder.
type sessionScheduler struct {
	e       *Engine
	workdir string
}

func scheduleInfo(s schedule.Schedule) tool.ScheduleInfo {
	info := tool.ScheduleInfo{ID: string(s.ID), Cron: s.Cron, Prompt: s.Prompt, Agent: s.Agent}
	if !s.Next.IsZero() {
		info.Next = s.Next.Format(time.RFC3339)
	}
	return info
}

func (s sessionScheduler) Create(ctx context.Context, cron, prompt, agentName string) (tool.ScheduleInfo, error) {
	created, err := s.e.CreateSchedule(ctx, cron, prompt, agentName, s.workdir)
	if err != nil {
		return tool.ScheduleInfo{}, err
	}
	return scheduleInfo(created), nil
}

func (s sessionScheduler) List(ctx context.Context) ([]tool.ScheduleInfo, error) {
	listed, err := s.e.ListSchedules(ctx)
	if err != nil {
		return nil, err
	}
	var infos []tool.ScheduleInfo
	for _, item := range listed {
		if item.Workdir == s.e.directory(s.workdir) {
			infos = append(infos, scheduleInfo(item))
		}
	}
	return infos, nil
}

func (s sessionScheduler) Delete(ctx context.Context, id string) error {
	found, err := s.e.schedules.Get(ctx, event.ID(id))
	if err != nil || found.Workdir != s.e.directory(s.workdir) {
		return errors.New("no scheduled task of this folder has that id")
	}
	return s.e.DeleteSchedule(ctx, found.ID)
}
