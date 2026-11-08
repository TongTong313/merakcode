package group

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

const Updated event.Type = "group.updated"

func init() { event.Register[Group](Updated) }

func validateSettings(settings Settings, members []Member) error {
	switch settings.Initiative {
	case "", Passive, Normal, Eager:
	default:
		return errors.New("invalid group initiative")
	}
	if err := ValidateTriggers(settings.Triggers); err != nil {
		return err
	}
	for _, trigger := range settings.Triggers {
		if trigger.Then.Member == "" {
			continue
		}
		found := false
		for _, member := range members {
			if member.ID == trigger.Then.Member && member.Kind == MemberAgent && member.AgentRole == AgentWorker {
				found = true
			}
		}
		if !found {
			return errors.New("trigger member must be a worker in this group")
		}
	}
	return nil
}

func (m *Manager) UpdateSettings(ctx context.Context, id, human event.ID, settings Settings) (Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return Group{}, err
	}
	allowed := false
	for _, member := range state.Members {
		if member.ID == human && member.Can(RoleAdmin) {
			allowed = true
		}
	}
	if !allowed {
		return Group{}, errors.New("group settings require an admin or owner")
	}
	if err := validateSettings(settings, state.Members); err != nil {
		return Group{}, err
	}
	state.Group.Settings = settings
	body, err := json.Marshal(state.Group)
	if err != nil {
		return Group{}, err
	}
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: Updated, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Payload: body})
	return state.Group, err
}
