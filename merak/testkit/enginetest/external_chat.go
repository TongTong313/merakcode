package enginetest

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// ExternalRig is an engine with a saved external agent that runs the Claude Code fixture.
type ExternalRig struct {
	T         *testing.T
	Engine    *engine.Engine
	Context   context.Context
	Directory string
	Agent     definition.Agent
}

func (r *ExternalRig) answers(id event.ID) int {
	r.T.Helper()
	facts, err := r.Engine.FindEvents(r.Context, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
	if err != nil {
		r.T.Fatal(err)
	}
	return len(facts)
}

// Say sends a message to an external conversation and waits for the answer number want.
func (r *ExternalRig) Say(id event.ID, text string, want int) {
	r.T.Helper()
	if err := r.Engine.Send(r.Context, id, []model.Part{{Text: text}}); err != nil {
		r.T.Fatal(err)
	}
	WaitFor(r.T, r.Context, "answer "+text, func() bool { return r.answers(id) >= want })
}

func (r *ExternalRig) SetDisabled(disabled bool) {
	r.T.Helper()
	saved := r.Agent
	saved.Disabled = disabled
	if _, err := r.Engine.SaveAgent(r.Context, "owner", saved); err != nil {
		r.T.Fatal(err)
	}
}
