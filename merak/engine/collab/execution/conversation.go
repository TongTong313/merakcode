package execution

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Execution) StopExternalChat(id event.ID) bool {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	chat := domain.externals[id]
	if chat == nil {
		return false
	}
	chat.pending = nil
	if chat.active != nil {
		_ = chat.active.Cancel(domain.core.Ctx)
	}
	return true
}

// titleExternal names a conversation with an external product after its first answer, as maybeTitle does for the
// engine's own conversations. The caller is the goroutine that drives the conversation.
func (domain *Execution) titleExternal(id event.ID, chat *externalChat) {
	domain.mu.Lock()
	skip := chat.titled
	domain.mu.Unlock()
	ref, ok := domain.registry.JobModel("title")
	provider := domain.registry.Provider(ref.Provider)
	state, err := domain.manager.Load(domain.core.Ctx, id)
	if skip || !ok || provider == nil || err != nil || state.Read().Title != "" {
		return
	}
	state = state.Read()
	first, answer := conversation.TitleSource(state.Messages)
	if first == "" || answer == "" {
		return
	}
	domain.mu.Lock()
	chat.titled = true
	domain.mu.Unlock()
	ctx, cancel := context.WithTimeout(domain.core.Ctx, 30*time.Second)
	defer cancel()
	title := domain.conversation.WriteTitle(ctx, provider, ref.Model, first, answer)
	if title == "" {
		return
	}
	body, err := json.Marshal(session.Change{Title: &title})
	if err != nil {
		return
	}
	scope := state.Scope
	scope.Session = id
	if current, err := domain.manager.Load(ctx, id); err != nil || current.Read().Title != "" {
		return
	}
	_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + id), Scope: scope, Type: session.Updated, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
}

// externalChat is a conversation driven by an external product: the engine keeps who it talks to, and every
// message starts a run of that product in the same session. A product that takes messages mid-run gets them
// in its running process; the others get one run after the other.
type externalChat struct {
	Agent   event.ID        `json:"agent"`
	Workdir string          `json:"workdir"`
	Mode    permission.Mode `json:"mode,omitempty"`

	pending []string
	steered []conversation.SteeredInput
	active  worker.Run
	running bool
	titled  bool
}

const externalChatKind = "chat-agent"

// createExternalChat records a conversation with an external product; its session starts with the first message.
func (domain *Execution) CreateExternalChat(ctx context.Context, p definition.Agent, options conversation.SessionOptions) (event.ID, error) {
	if err := folder.Existing(options.Workdir); err != nil {
		return "", errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	chat := externalChat{Agent: p.ID, Workdir: options.Workdir, Mode: options.Mode}
	if chat.Mode == "" {
		chat.Mode = p.Mode
	}
	body, err := json.Marshal(chat)
	if err != nil {
		return "", err
	}
	id := domain.core.NewID()
	if err := domain.core.Store.Put(ctx, store.Doc{Kind: externalChatKind, Key: string(id), Body: body}); err != nil {
		return "", err
	}
	return id, nil
}

// externalChatOf returns the external conversation of an id, or nil when it is an engine conversation. The
// caller holds domain.mu.
func (domain *Execution) externalChatOf(ctx context.Context, id event.ID) (*externalChat, error) {
	if chat := domain.externals[id]; chat != nil {
		return chat, nil
	}
	doc, err := domain.core.Store.Fetch(ctx, externalChatKind, string(id))
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
	domain.externals[id] = chat
	return chat, nil
}

func (domain *Execution) HasExternalChat(ctx context.Context, id event.ID) (bool, error) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	chat, err := domain.externalChatOf(ctx, id)
	return chat != nil, err
}

// ExternalAgent returns the agent that drives a conversation, or "" when the engine's own model does.
func (domain *Execution) ExternalAgent(ctx context.Context, id event.ID) (event.ID, error) {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	chat, err := domain.externalChatOf(ctx, id)
	if chat == nil {
		return "", err
	}
	return chat.Agent, nil
}

// TakeOverSession turns a conversation with an external product into one of the engine's own: the history stays in
// the session, only the record of who drives it goes, and the next message is answered by the model the client picks.
func (domain *Execution) TakeOverSession(ctx context.Context, id event.ID, confirm bool, selection session.Selection) error {
	if !confirm {
		return errorcode.Coded(errorcode.TakeoverNeedsConfirmation, errors.New("a takeover needs confirmation"))
	}
	if selection.Provider == "" {
		if fallback := domain.registry.DefaultModel(); fallback != nil {
			selection = session.Selection{Provider: fallback.Provider, Model: fallback.Model, Thinking: fallback.Thinking}
		}
	}
	if selection.Model == "" || domain.registry.Provider(selection.Provider) == nil {
		return errorcode.Coded(errorcode.SessionRequestFailed, errors.New("a takeover needs a configured model"))
	}
	domain.waitExternalIdle(ctx, id)
	domain.mu.Lock()
	defer domain.mu.Unlock()
	chat, err := domain.externalChatOf(ctx, id)
	if err != nil {
		return err
	}
	if chat == nil {
		return errorcode.Coded(errorcode.SessionRequestFailed, errors.New("the conversation is not driven by an external product"))
	}
	if chat.running || chat.active != nil || len(chat.pending) > 0 {
		return errorcode.Coded(errorcode.SessionBusy, errors.New("take over between turns"))
	}
	if err := domain.conversation.TakeOverState(ctx, id, selection); err != nil {
		return err
	}
	if err := domain.core.Store.Delete(ctx, externalChatKind, string(id)); err != nil {
		return err
	}
	delete(domain.externals, id)
	return nil
}

// waitExternalIdle gives a run of an external product that has just answered a moment to leave the engine's books.
func (domain *Execution) waitExternalIdle(ctx context.Context, id event.ID) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		domain.mu.Lock()
		chat := domain.externals[id]
		idle := chat == nil || !chat.running && chat.active == nil && len(chat.pending) == 0
		domain.mu.Unlock()
		if idle || ctx.Err() != nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// sendExternalSession keeps the shutdown check, external state changes and worker registration under one lock.
func (domain *Execution) SendExternalSession(ctx context.Context, id event.ID, parts []model.Part) (bool, error) {
	for {
		domain.mu.Lock()
		if domain.core.Ctx.Err() != nil {
			domain.mu.Unlock()
			return false, errors.New("MRK-4001")
		}
		chat, err := domain.externalChatOf(ctx, id)
		if err != nil || chat == nil {
			domain.mu.Unlock()
			return false, err
		}
		var text strings.Builder
		for _, part := range parts {
			text.WriteString(part.Text)
		}
		if strings.TrimSpace(text.String()) == "" {
			domain.mu.Unlock()
			return true, errorcode.Coded(errorcode.SessionRequestFailed, errors.New("an external conversation takes text"))
		}
		agent := chat.Agent
		domain.mu.Unlock()
		p, loadErr := domain.registry.LoadAgentByID(ctx, agent)
		domain.mu.Lock()
		if domain.core.Ctx.Err() != nil {
			domain.mu.Unlock()
			return false, errors.New("MRK-4001")
		}
		current, err := domain.externalChatOf(ctx, id)
		if err != nil || current == nil {
			domain.mu.Unlock()
			return false, err
		}
		if current != chat {
			domain.mu.Unlock()
			continue
		}
		err = domain.sendExternal(ctx, id, chat, parts, text.String(), p, loadErr)
		domain.mu.Unlock()
		return true, err
	}
}

// sendExternal hands a message to the product of an external conversation. The caller holds domain.mu.
func (domain *Execution) sendExternal(ctx context.Context, id event.ID, chat *externalChat, parts []model.Part, text string, p definition.Agent, loadErr error) error {
	if loadErr == nil && p.Disabled {
		return errorcode.Coded(errorcode.AgentDisabled, errors.New("the agent of this conversation is turned off"))
	}
	if chat.active != nil {
		if loadErr == nil && domain.runnerFor(p, nil).Caps().Steer {
			if chat.active.Send(ctx, loop.Input{Parts: parts, Actor: event.Actor{Kind: event.ActorHuman}}) == nil {
				chat.steered = append(chat.steered, conversation.SteeredInput{Text: text, At: domain.core.Now()})
				return nil
			}
		}
	}
	chat.pending = append(chat.pending, text)
	if chat.running {
		return nil
	}
	chat.running = true
	domain.core.Workers.Go(func() { domain.driveExternal(id, chat) })
	return nil
}

// driveExternal runs the queued messages of an external conversation one after the other.
func (domain *Execution) driveExternal(id event.ID, chat *externalChat) {
	for {
		domain.mu.Lock()
		if len(chat.pending) == 0 || domain.core.Ctx.Err() != nil {
			chat.running, chat.active = false, nil
			domain.mu.Unlock()
			return
		}
		text := chat.pending[0]
		chat.pending = chat.pending[1:]
		domain.mu.Unlock()
		p, err := domain.registry.LoadAgentByID(domain.core.Ctx, chat.Agent)
		if err != nil {
			continue
		}
		run, err := domain.StartWorker(domain.core.Ctx, p, worker.Assignment{Session: id, Workdir: chat.Workdir, Packet: text, Mode: chat.Mode})
		if err != nil {
			continue
		}
		domain.mu.Lock()
		chat.active = run
		domain.mu.Unlock()
		_, _ = run.Wait(context.Background())
		domain.titleExternal(id, chat)
		domain.mu.Lock()
		chat.active = nil
		steered := chat.steered
		chat.steered = nil
		domain.mu.Unlock()
		if unseen := domain.conversation.UnseenSteered(domain.core.Ctx, id, steered); len(unseen) > 0 {
			domain.mu.Lock()
			chat.pending = append(unseen, chat.pending...)
			domain.mu.Unlock()
		}
	}
}
