package enginetest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// ChatRig is a conversation with the fake model; every turn waits for its end.
type ChatRig struct {
	T         *testing.T
	Engine    *engine.Engine
	Context   context.Context
	Directory string
	ID        event.ID
}

func NewChatRig(t *testing.T, options conversation.SessionOptions, replies ...fake.Reply) *ChatRig {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	t.Cleanup(cancel)
	dir := t.TempDir()
	deps := Deps(t)
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"fake": fake.New(t, replies...)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	options.Provider, options.Workdir = "fake", dir
	id, err := e.CreateSession(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	return &ChatRig{T: t, Engine: e, Context: ctx, Directory: dir, ID: id}
}

// Say sends a message and returns the id of its message.sent event once the turn has finished.
func (r *ChatRig) Say(text string) event.ID {
	r.T.Helper()
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: r.ID}, Types: []event.Type{loop.TurnFinished, session.MessageSent}})
	defer stop()
	if err := r.Engine.Send(r.Context, r.ID, []model.Part{{Text: text}}); err != nil {
		r.T.Fatal(err)
	}
	var sent event.ID
	for {
		select {
		case fact := <-facts:
			if fact.Type == session.MessageSent && sent == "" {
				sent = fact.ID
			}
			if fact.Type == loop.TurnFinished {
				return sent
			}
		case <-r.Context.Done():
			r.T.Fatal("the turn did not finish")
		}
	}
}

func (r *ChatRig) State() session.State {
	r.T.Helper()
	state, err := r.Engine.SessionSnapshot(r.Context, r.ID)
	if err != nil {
		r.T.Fatal(err)
	}
	return state
}

func (r *ChatRig) File(name string) (string, bool) {
	body, err := os.ReadFile(filepath.Join(r.Directory, name))
	return string(body), err == nil
}

const StructuredSummary = "# Summary of earlier work\n## Goal\nPlan the work\n## Constraints (verbatim)\nNone\n## Decisions\nNone\n## Files touched\nNone\n## Current state\nDone\n## Open questions\nNone\n## References\nNone\n## Earlier\nNone"
