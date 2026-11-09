package group

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (m *Manager) SetUnconfined(ctx context.Context, id, memberID event.ID, unconfined bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	for _, member := range state.Members {
		if member.ID != memberID || member.Kind != MemberAgent {
			continue
		}
		if member.Unconfined == unconfined {
			return nil
		}
		member.Unconfined = unconfined
		body, err := json.Marshal(member)
		if err != nil {
			return err
		}
		_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: MemberUpdated, Actor: event.Actor{Kind: event.ActorAgent, ID: memberID}, Payload: body})
		return err
	}
	return store.ErrNotFound
}
