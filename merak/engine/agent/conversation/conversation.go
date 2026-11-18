package conversation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/agent/skill"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	platformlog "github.com/TongTong313/merakcode/merak/engine/infra/log"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
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

// Conversation holds one session and its running loop.
type Conversation struct {
	mcpServers       map[string]config.MCPServer
	mcpReady         bool
	suppressChildren bool
	titled           bool
	// Recommender suggests skills for the messages of this conversation; nil in a conversation of a group or a child.
	Recommender *skill.Recommender
	// fromCommand marks the next message as the expansion of a slash command, which already says what it wants.
	fromCommand  bool
	Children     Children
	memoryCancel context.CancelFunc
	State        *session.State
	Runner       loop.Loop
	queue        chan *conversationTurn
	Turns        map[*conversationTurn]struct{}
}

type conversationTurn struct {
	budgetCause  event.ID
	extendBudget bool
	selection    *session.Selection
	ctx          context.Context
	cancel       context.CancelFunc
	parts        []model.Part
}

func (domain *Manager) CreateSession(ctx context.Context, options SessionOptions) (event.ID, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if options.Key != "" {
		return domain.createKeyed(ctx, options)
	}
	if options.Agent != "" {
		p, err := domain.registry.LoadAgentByID(ctx, options.Agent)
		if err != nil {
			return "", errorcode.Coded(errorcode.SessionRequestFailed, err)
		}
		if p.Disabled {
			return "", errorcode.Coded(errorcode.AgentDisabled, errors.New("the agent is turned off"))
		}
		if p.Product != nil && p.Product.Kind != definition.KindBuiltin {
			if domain.hooks.External == nil {
				return "", errors.New("MRK-4001")
			}
			return domain.hooks.External.Create(ctx, p, options)
		}
		if chosen, err := domain.registry.MemberModel(p.Model); err == nil && options.Provider == "" {
			options.Provider, options.Model, options.Thinking = chosen.Provider, chosen.Model, chosen.Thinking
		}
		options.System += p.System
		if options.Mode == "" {
			options.Mode = p.Mode
		}
	} else if options.Parent == "" {
		domain.applyDefaultAgent(&options)
	}
	if options.Provider == "" {
		if fallback := domain.registry.DefaultModel(); fallback != nil {
			options.Provider, options.Model, options.Thinking = fallback.Provider, fallback.Model, fallback.Thinking
		}
	}
	c, err := domain.NewConversation(ctx, options)
	if err != nil {
		return "", err
	}
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if domain.core.Ctx.Err() != nil {
		c.Runner.Env.Jobs.Close()
		return "", errors.New("MRK-4001")
	}
	c.State, err = domain.manager.Create(ctx, *c.State)
	if err != nil {
		c.Runner.Env.Jobs.Close()
		return "", err
	}
	domain.startConversation(c)
	return c.State.Read().ID, nil
}

func (domain *Manager) startConversation(c *Conversation) {
	domain.sessions[c.State.Read().ID] = c
	domain.core.Workers.Go(func() {
		defer domain.afterTurn(domain.core.Ctx, c, c.State.Read().ID, Close)
		defer c.Runner.Env.Jobs.Close()
		var childrenReady <-chan struct{}
		if c.Children != nil {
			defer c.Children.Close()
			childrenReady = c.Children.Ready()
		}
		timer := time.NewTimer(time.Hour)
		timer.Stop()
		defer timer.Stop()
		var idle <-chan time.Time
		for {
			select {
			case <-domain.core.Ctx.Done():
				return
			case <-childrenReady:
				for _, input := range c.Children.Poll() {
					if input.Child != nil && c.State.Read().Children[input.Child.ID].Delivered {
						continue
					}
					domain.mu.Lock()
					suppressed := c.suppressChildren
					childCtx, cancel := context.WithCancel(domain.core.Ctx)
					turn := &conversationTurn{ctx: childCtx, cancel: cancel}
					c.Turns[turn] = struct{}{}
					domain.mu.Unlock()
					if suppressed {
						_ = c.Runner.Inject(childCtx, c.State, []loop.Input{input})
						_ = domain.manager.Snapshot(childCtx, c.State)
					} else {
						_, _ = domain.RunInput(childCtx, c, input)
					}
					cancel()
					domain.mu.Lock()
					delete(c.Turns, turn)
					domain.mu.Unlock()
				}
			case <-idle:
				idle = nil
				domain.extractMemory(c)
			case turn := <-c.queue:
				timer.Stop()
				idle = nil
				outcome, err := domain.RunInput(turn.ctx, c, loop.Input{Parts: turn.parts, Actor: event.Actor{Kind: event.ActorHuman}, Selection: turn.selection, ExtendBudget: turn.extendBudget})
				turn.cancel()
				domain.mu.Lock()
				delete(c.Turns, turn)
				domain.mu.Unlock()
				if err == nil && outcome.Stop == loop.Answered {
					domain.maybeTitle(c)
					timer.Reset(domain.memoryIdle)
					idle = timer.C
				}
			}
		}
	})
}

func (domain *Manager) Cancel(id event.ID) error {
	domain.mu.Lock()
	c := domain.sessions[id]
	if c == nil {
		domain.mu.Unlock()
		for _, stop := range domain.hooks.Stop {
			if stop(id) {
				return nil
			}
		}
		return errors.New("MRK-4001")
	}
	running := len(c.Turns) > 0
	for turn := range c.Turns {
		turn.cancel()
	}
	c.suppressChildren = true
	if c.Children != nil {
		c.Children.Cancel()
	}
	if c.memoryCancel != nil {
		c.memoryCancel()
	}
	domain.mu.Unlock()
	if running {
		for _, cancelled := range domain.hooks.Cancelled {
			cancelled(domain.core.Ctx, id)
		}
	}
	return nil
}

func (domain *Manager) Send(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	return domain.SendWithBudget(ctx, id, parts, false, selections...)
}

func (domain *Manager) SendWithBudget(ctx context.Context, id event.ID, parts []model.Part, extendBudget bool, selections ...session.Selection) error {
	var selected *session.Selection
	if len(selections) > 1 {
		return errors.New("MRK-4001")
	}
	if len(selections) == 1 {
		value := selections[0]
		if value.Model == "" || domain.registry.Provider(value.Provider) == nil {
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
	domain.mu.Lock()
	c := domain.sessions[id]
	if domain.core.Ctx.Err() != nil {
		domain.mu.Unlock()
		return errors.New("MRK-4001")
	}
	if c == nil {
		domain.mu.Unlock()
		if external := domain.hooks.External; external != nil {
			handled, err := external.Send(ctx, id, copy)
			if handled || err != nil {
				return err
			}
		}
		domain.mu.Lock()
		if domain.core.Ctx.Err() != nil {
			domain.mu.Unlock()
			return errors.New("MRK-4001")
		}
		c = domain.sessions[id]
	}
	defer domain.mu.Unlock()
	if c == nil {
		state, err := domain.manager.Load(ctx, id)
		if err != nil {
			return err
		}
		if err := domain.manager.Reconcile(ctx, state); err != nil {
			return err
		}
		c, err = domain.ConversationFor(state)
		if err != nil {
			return err
		}
		domain.startConversation(c)
	}
	var budgetCause event.ID
	if c.State.Read().Config.Budget != (session.Budget{}) || extendBudget {
		facts, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
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
		if loop.BudgetStop(outcome.Stop) && !extendBudget || extendBudget && (c.State.Read().Scope.Group != "" || !loop.BudgetStop(outcome.Stop)) {
			return errors.New("MRK-4005")
		}
		if extendBudget {
			for pending := range c.Turns {
				if pending.budgetCause == budgetCause {
					return errors.New("MRK-4005")
				}
			}
		}
	}
	turnCtx, cancel := context.WithCancel(domain.core.Ctx)
	turn := &conversationTurn{ctx: turnCtx, cancel: cancel, parts: copy, selection: selected, extendBudget: extendBudget, budgetCause: budgetCause}
	select {
	case c.queue <- turn:
		c.suppressChildren = false
		if c.memoryCancel != nil {
			c.memoryCancel()
		}
		c.Turns[turn] = struct{}{}
		return nil
	default:
		cancel()
		return errors.New("MRK-4001")
	}
}

func (domain *Manager) runConversation(ctx context.Context, c *Conversation, parts []model.Part) (loop.Outcome, error) {
	return domain.RunInput(ctx, c, loop.Input{Parts: parts, Actor: event.Actor{Kind: event.ActorHuman}})
}

func (domain *Manager) RunInput(ctx context.Context, c *Conversation, input loop.Input) (loop.Outcome, error) {
	state := c.State.Read()
	if input.ExtendBudget {
		body, _ := json.Marshal(state.Config.Budget)
		_, err := c.State.Publish(ctx, domain.core.Bus, event.Event{Stream: event.Stream("session:" + state.ID), Scope: state.Scope, Type: session.BudgetExtended, Actor: input.Actor, Payload: body})
		if err != nil {
			return loop.Outcome{}, err
		}
	}
	var completed []func(loop.Outcome)
	for _, prepare := range domain.hooks.BeforeTurn {
		after, err := prepare(ctx, c)
		if err != nil {
			return loop.Outcome{}, err
		}
		if after != nil {
			completed = append(completed, after)
		}
	}
	done := c.Runner.Env.Sandbox.Hold()
	defer done()
	domain.prepareMCP(ctx, c)
	state = c.State.Read()
	selected := session.Selection{Provider: state.Config.Provider, Model: state.Config.Model, Thinking: state.Config.Thinking}
	if input.Selection != nil {
		selected = *input.Selection
	}
	if c.Children != nil {
		config := state.Config
		config.Provider, config.Model, config.Thinking = selected.Provider, selected.Model, selected.Thinking
		c.Children.SetRun(domain.childRun(state.ID, state.Scope, config))
	}
	provider := domain.registry.Provider(selected.Provider)
	if provider == nil {
		provider = unavailableProvider(selected.Provider)
	}
	c.Runner.Model = provider
	c.Runner.Window.Summarize = domain.registry.Summarizer(provider)
	c.Runner.Window.ManualOnly = domain.autoCompactOff.Load()
	c.Runner.ModelID, c.Runner.Thinking = selected.Model, selected.Thinking
	parts := input.Parts
	entry := domain.catalog.Get(selected.Provider, selected.Model)
	c.Runner.Window.Budget.Window = entry.Window
	c.Runner.Window.Budget.Reserve = max(entry.MaxOutput/4, 8192)
	if len(state.Messages) == 0 && input.Child == nil {
		if state.Scope.Task == "" || state.Config.ToolPool == "leader.default" {
			var text string
			for _, part := range parts {
				text += part.Text + "\n"
			}
			var notes []memory.Note
			var recallErr error
			if domain.MemoryRecallOn() {
				notes, recallErr = domain.notes.Recall(ctx, memory.Query{Owners: c.Runner.Env.MemoryOwners, Text: text, Limit: 5})
				if recallErr == nil && len(notes) == 0 {
					notes, recallErr = domain.notes.Recall(ctx, memory.Query{Owners: c.Runner.Env.MemoryOwners, Limit: 5})
				}
			}
			if recallErr == nil && len(notes) > 0 {
				parts = append([]model.Part{{Text: memory.Format(notes), Synthetic: true}}, parts...)
			}
		}
		parts = append([]model.Part{{Text: "Current date and time: " + domain.core.Now().Format(time.RFC3339), Synthetic: true}}, parts...)
	}
	domain.mu.Lock()
	expanded := c.fromCommand && input.Actor.Kind == event.ActorHuman
	if expanded {
		c.fromCommand = false
	}
	domain.mu.Unlock()
	for _, rewrite := range domain.hooks.Input {
		var err error
		parts, err = rewrite(ctx, c, input, parts, expanded)
		if err != nil {
			return loop.Outcome{}, err
		}
	}
	input.Parts = parts
	outcome, err := c.Runner.RunTurn(ctx, c.State, input)
	for _, after := range completed {
		after(outcome)
	}
	state = c.State.Read()
	if domain.core.Logger != nil {
		logger := platformlog.With(domain.core.Logger, state.Scope).With("event", string(state.Scope.Turn))
		if err != nil {
			logger.Error("turn failed", "code", outcome.Code)
		} else {
			logger.Info("turn finished", "stop", outcome.Stop)
		}
	}
	snapshotCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if snapshotErr := domain.afterTurn(snapshotCtx, c, state.ID, Snapshot); snapshotErr != nil && err == nil {
		err = snapshotErr
	}
	return outcome, err
}

type unavailableProvider string

func (p unavailableProvider) Name() string { return string(p) }

func (p unavailableProvider) Stream(context.Context, model.Request) (model.Stream, error) {
	return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("provider is no longer configured")}
}

// openSession returns the live conversation of a session, loading it from the store when it is not running.
// The caller holds the conversation mutex through loading, construction and worker registration.
func (domain *Manager) openSession(ctx context.Context, id event.ID) (*Conversation, error) {
	if c := domain.sessions[id]; c != nil {
		return c, nil
	}
	state, err := domain.manager.Load(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := domain.manager.Reconcile(ctx, state); err != nil {
		return nil, err
	}
	c, err := domain.ConversationFor(state)
	if err != nil {
		return nil, err
	}
	domain.startConversation(c)
	return c, nil
}

// PublishSession records a change of a session and folds it into the live state. The caller holds the conversation mutex.
func (domain *Manager) PublishSession(ctx context.Context, c *Conversation, kind event.Type, payload any) (event.Event, error) {
	state := c.State.Read()
	body, err := json.Marshal(payload)
	if err != nil {
		return event.Event{}, err
	}
	scope := state.Scope
	scope.Session = state.ID
	fact, err := c.State.Publish(ctx, domain.core.Bus, event.Event{Stream: event.Stream("session:" + state.ID), Scope: scope, Type: kind, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
	if err != nil {
		return event.Event{}, err
	}
	return fact, nil
}

func (domain *Manager) MarkFromCommand(ctx context.Context, id event.ID) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if c, err := domain.openSession(ctx, id); err == nil {
		c.fromCommand = true
	}
}

func (domain *Manager) AnnounceReviewUpdate(ctx context.Context, id event.ID, decision string, count int) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	if c, err := domain.openSession(ctx, id); err == nil {
		_, _ = domain.PublishSession(ctx, c, session.ReviewUpdated, session.ReviewUpdate{Decision: decision, Count: count})
	}
}

// UpdateSession changes the title, the archive state or the permission mode of a session. A mode change applies
// to the next turn and cannot happen while a turn runs; takeover needs an explicit confirmation.
func (domain *Manager) UpdateSession(ctx context.Context, id event.ID, update session.Update) error {
	if update.Mode != "" {
		domain.WaitIdle(ctx, id)
	}
	if update.Mode != "" && update.Mode != permission.ModeAsk && update.Mode != permission.ModeAuto && update.Mode != permission.ModeTakeover {
		return errorcode.Coded(errorcode.SessionRequestFailed, errors.New("unknown permission mode"))
	}
	if update.Mode == permission.ModeTakeover && !update.Confirm {
		return errorcode.Coded(errorcode.TakeoverNeedsConfirmation, errors.New("takeover needs confirmation"))
	}
	domain.mu.Lock()
	defer domain.mu.Unlock()
	c, err := domain.openSession(ctx, id)
	if err != nil {
		return err
	}
	if update.Mode != "" && len(c.Turns) > 0 {
		return errorcode.Coded(errorcode.SessionBusy, errors.New("the mode changes between turns"))
	}
	if _, err := domain.PublishSession(ctx, c, session.Updated, session.Change{Title: update.Title, Archived: update.Archived, Mode: update.Mode}); err != nil {
		return err
	}
	if update.Mode != "" {
		c.Runner.Env.Mode = string(update.Mode)
		c.Runner.Env.Sandbox.Disabled = update.Mode == permission.ModeTakeover
	}
	return domain.manager.Snapshot(ctx, c.State)
}

// WaitIdle gives a turn that has just finished a moment to leave the engine's books, so a client that acts the
// instant it sees turn.finished is not told the session is busy.
func (domain *Manager) WaitIdle(ctx context.Context, id event.ID) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		domain.mu.Lock()
		c := domain.sessions[id]
		idle := c == nil || len(c.Turns) == 0
		domain.mu.Unlock()
		if idle || ctx.Err() != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// CompactSession rebuilds the context of a session now, keeping its latest turn, without waiting for the
// context to fill up.
func (domain *Manager) CompactSession(ctx context.Context, id event.ID) error {
	domain.WaitIdle(ctx, id)
	domain.mu.Lock()
	c, err := domain.openSession(ctx, id)
	if err != nil {
		domain.mu.Unlock()
		return err
	}
	if len(c.Turns) > 0 {
		domain.mu.Unlock()
		return errorcode.Coded(errorcode.SessionBusy, errors.New("compact between turns"))
	}
	turnCtx, cancel := context.WithCancel(domain.core.Ctx)
	turn := &conversationTurn{ctx: turnCtx, cancel: cancel}
	c.Turns[turn] = struct{}{}
	domain.mu.Unlock()
	defer func() {
		cancel()
		domain.mu.Lock()
		delete(c.Turns, turn)
		domain.mu.Unlock()
	}()
	selected := c.State.Read().Config
	provider := domain.registry.Provider(selected.Provider)
	if provider == nil {
		return errorcode.Coded(errorcode.ContextRebuildFailed, errors.New("the provider is not configured"))
	}
	c.Runner.Window.Summarize = domain.registry.Summarizer(provider)
	entry := domain.catalog.Get(selected.Provider, selected.Model)
	c.Runner.Window.Budget.Window = entry.Window
	c.Runner.Window.Budget.Reserve = max(entry.MaxOutput/4, 8192)
	if err := c.Runner.Window.Compact(ctx, c.State); err != nil {
		return errorcode.Coded(errorcode.ContextRebuildFailed, err)
	}
	return domain.manager.Snapshot(ctx, c.State)
}

// DeleteSession removes a conversation and the children it started for good: its events, its snapshot and the
// record of its files. The project's files are not touched.
func (domain *Manager) DeleteSession(ctx context.Context, id event.ID) error {
	domain.WaitIdle(ctx, id)
	domain.mu.Lock()
	c, err := domain.openSession(ctx, id)
	if err != nil {
		domain.mu.Unlock()
		return err
	}
	if c.State.Read().Scope.Group != "" {
		domain.mu.Unlock()
		return errorcode.Coded(errorcode.SessionRequestFailed, errors.New("the conversation of a group is deleted with the group"))
	}
	if len(c.Turns) > 0 {
		domain.mu.Unlock()
		return errorcode.Coded(errorcode.SessionBusy, errors.New("delete between turns"))
	}
	delete(domain.sessions, id)
	domain.mu.Unlock()
	removed, err := domain.manager.Delete(ctx, id)
	if err != nil {
		return err
	}
	_ = domain.core.Store.Delete(ctx, "review", string(id))
	for _, victim := range removed {
		for _, deleted := range domain.hooks.Deleted {
			deleted(ctx, victim)
		}
	}
	return nil
}

// OpenLocked keeps the existing revert operation under the conversation lock. The caller must defer unlock.
func (domain *Manager) OpenLocked(ctx context.Context, id event.ID) (*Conversation, func(), error) {
	domain.mu.Lock()
	c, err := domain.openSession(ctx, id)
	if err != nil {
		domain.mu.Unlock()
		return nil, nil, err
	}
	return c, domain.mu.Unlock, nil
}

// maybeTitle names a conversation after its first answer, with the small model. A title the user set meanwhile
// is never replaced, and nothing happens when no model is configured for small jobs.
func (domain *Manager) maybeTitle(c *Conversation) {
	domain.mu.Lock()
	state := c.State.Read()
	skip := c.titled || state.Title != "" || state.Scope.Group != "" || state.Config.Parent != ""
	c.titled = true
	domain.mu.Unlock()
	ref, ok := domain.registry.JobModel("title")
	provider := domain.registry.Provider(ref.Provider)
	if skip || !ok || provider == nil {
		return
	}
	domain.mu.Lock()
	first, answer := TitleSource(state.Messages)
	domain.mu.Unlock()
	domain.core.Workers.Go(func() {
		ctx, cancel := context.WithTimeout(domain.core.Ctx, 30*time.Second)
		defer cancel()
		title := domain.WriteTitle(ctx, provider, ref.Model, first, answer)
		if title == "" {
			return
		}
		domain.mu.Lock()
		defer domain.mu.Unlock()
		state := c.State.Read()
		if state.Title != "" || domain.sessions[state.ID] != c {
			return
		}
		if _, err := domain.PublishSession(ctx, c, session.Updated, session.Change{Title: &title}); err == nil {
			_ = domain.manager.Snapshot(ctx, c.State)
		}
	})
}

// TitleSource is the text of the first message of the user and of the first answer, which a title is written from.
func TitleSource(messages []model.Message) (first, answer string) {
	var user, assistant strings.Builder
	for _, message := range messages {
		target := &user
		if message.Role == model.Assistant {
			target = &assistant
		} else if message.Role != model.User {
			continue
		}
		for _, part := range message.Parts {
			if part.Text != "" && !part.Synthetic && target.Len() < 2000 {
				target.WriteString(part.Text + "\n")
			}
		}
		if user.Len() > 0 && assistant.Len() > 0 {
			break
		}
	}
	return user.String(), assistant.String()
}

// WriteTitle asks the model for a short title of a conversation from its first message and first answer; an empty
// string means no usable title came back.
func (domain *Manager) WriteTitle(ctx context.Context, provider model.Provider, modelID, first, answer string) string {
	request := model.Request{Model: modelID, MaxTokens: 60, System: "Write a title of at most 50 characters for the conversation below, in the language of the user. Reply with the title only: no quotes, no punctuation at the end.", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "User:\n" + first + "\nAssistant:\n" + answer}}}}}
	stream, err := provider.Stream(ctx, request)
	if err != nil {
		return ""
	}
	defer stream.Close()
	var collector model.Collector
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return ""
		}
		collector.Add(chunk)
	}
	message, _, _ := collector.Message()
	var text strings.Builder
	for _, part := range message.Parts {
		text.WriteString(part.Text)
	}
	return cleanTitle(text.String())
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

// TakeOverState serializes the shared session state with native conversation updates.
func (domain *Manager) TakeOverState(ctx context.Context, id event.ID, selection session.Selection) error {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	state, err := domain.manager.Load(ctx, id)
	if err != nil {
		return errorcode.Coded(errorcode.SessionRequestFailed, errors.New("the external conversation has no history to take over"))
	}
	body, err := json.Marshal(session.Change{Provider: selection.Provider, Model: selection.Model, Thinking: selection.Thinking})
	if err != nil {
		return err
	}
	scope := state.Read().Scope
	scope.Session = id
	_, err = state.Publish(ctx, domain.core.Bus, event.Event{Stream: event.Stream("session:" + id), Scope: scope, Type: session.Updated, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
	if err != nil {
		return err
	}
	return domain.manager.Snapshot(ctx, state)
}

// SteeredInput is a message pushed into a running product; if the run ends without showing it in the session, it
// goes to the next run.
type SteeredInput struct {
	Text string
	At   time.Time
}

// UnseenSteered returns the steered messages that never appeared as a message of the user in the session.
func (domain *Manager) UnseenSteered(ctx context.Context, id event.ID, steered []SteeredInput) []string {
	var unseen []string
	for _, input := range steered {
		quoted, _ := json.Marshal(input.Text)
		facts, err := domain.core.Store.Find(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageSent}, After: input.At.Add(-time.Second), Text: strings.Trim(string(quoted), `"`)})
		if err != nil || len(facts) == 0 {
			unseen = append(unseen, input.Text)
		}
	}
	return unseen
}

func CleanTitleTo(text string, limit int) string {
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
func (domain *Manager) createKeyed(ctx context.Context, options SessionOptions) (event.ID, error) {
	name := string(sha256Key(options.Key))
	domain.keyMu.Lock()
	defer domain.keyMu.Unlock()
	var stale uint64
	if doc, err := domain.core.Store.Fetch(ctx, sessionKeyKind, name); err == nil {
		if _, err := domain.SessionSnapshot(ctx, event.ID(doc.Body)); err == nil {
			return event.ID(doc.Body), nil
		}
		stale = doc.Rev // the conversation was deleted since: this key makes a new one
	} else if !errors.Is(err, store.ErrNotFound) {
		return "", err
	}
	options.Key = ""
	id, err := domain.CreateSession(ctx, options)
	if err != nil {
		return "", err
	}
	return id, domain.core.Store.Put(ctx, store.Doc{Kind: sessionKeyKind, Key: name, Rev: stale, Body: []byte(id)})
}

func sha256Key(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:16])
}

// ContextReport says where the context of a conversation goes: the system prompt, the tools and the messages.
func (domain *Manager) ContextReport(state session.State) string {
	request := model.Request{Model: state.Config.Model, System: state.System, Messages: state.Messages}
	for _, spec := range state.Tools {
		request.Tools = append(request.Tools, model.ToolSpec{Name: spec.Name, Description: spec.Description, Input: spec.Input})
	}
	estimate := domain.counter.Estimate(state.Config.Provider, request)
	entry := domain.catalog.Get(state.Config.Provider, state.Config.Model)
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

// SetLocalHuman sets the person the notices of scheduled runs go to; the server passes the identity of its own
// connections.
func (domain *Manager) SetLocalHuman(human event.ID) { domain.localHuman = human }

func (domain *Manager) afterTurn(ctx context.Context, c *Conversation, id event.ID, stage EndStage) error {
	for _, after := range domain.hooks.AfterTurn {
		if err := after(ctx, c, id, stage); err != nil {
			return err
		}
	}
	return nil
}
