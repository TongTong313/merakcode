package group

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

const Paused event.Type = "group.paused"
const Resumed event.Type = "group.resumed"

type Control struct {
	Thread  event.ID `json:"thread"`
	Session event.ID `json:"session,omitempty"`
	Code    string   `json:"code,omitempty"`
}

func init() { event.Register[Control](Paused); event.Register[Control](Resumed) }

func (s State) IsPaused(thread event.ID) bool {
	return slices.Contains(s.PausedThreads, s.Group.ID) || slices.Contains(s.PausedThreads, thread)
}

func FoldPauses(paused []event.ID, fact event.Event) ([]event.ID, error) {
	control, err := event.Decode[Control](fact)
	if err != nil {
		return nil, err
	}
	thread := control.Thread
	if thread == "" {
		thread = fact.Scope.Group
	}
	if fact.Type == Paused {
		if !slices.Contains(paused, thread) {
			paused = append(paused, thread)
		}
		return paused, nil
	}
	if thread == fact.Scope.Group {
		return nil, nil
	}
	return slices.DeleteFunc(paused, func(id event.ID) bool { return id == thread }), nil
}

func (m *Manager) SetPaused(ctx context.Context, id, human, thread event.ID, paused bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(state.Members, func(member Member) bool { return member.ID == human && member.Can(RoleAdmin) }) {
		return errors.New("group control requires an admin or owner")
	}
	if thread == "" {
		thread = id
	}
	kind := Resumed
	if paused {
		kind = Paused
	}
	scope := event.Scope{Group: id}
	if thread != id {
		scope.Task = thread
	}
	body, _ := json.Marshal(Control{Thread: thread})
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: scope, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Type: kind, Payload: body})
	return err
}
