package group

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

const Updated event.Type = "group.updated"

func init() { event.Register[Group](Updated) }

func validateSettings(settings Settings, members []Member) error {
	if err := (sandbox.Network{Hosts: settings.AllowedHosts}).Validate(); err != nil {
		return err
	}
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

func (m *Manager) AllowNetworkHost(ctx context.Context, id, human event.ID, host string) error {
	if err := (sandbox.Network{Hosts: []string{host}}).Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	allowed := slices.ContainsFunc(state.Members, func(member Member) bool { return member.ID == human && member.Can(RoleAdmin) })
	if !allowed {
		return errors.New("new network hosts require an admin or owner")
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if slices.ContainsFunc(state.Group.Settings.AllowedHosts, func(known string) bool {
		return strings.EqualFold(strings.TrimSuffix(known, "."), host)
	}) {
		return nil
	}
	state.Group.Settings.AllowedHosts = append(state.Group.Settings.AllowedHosts, host)
	body, err := json.Marshal(state.Group)
	if err != nil {
		return err
	}
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: Updated, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Payload: body})
	return err
}

func (m *Manager) AcceptMemberHost(ctx context.Context, id, human, memberID event.ID, host string) error {
	if err := (sandbox.Network{Hosts: []string{host}}).Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(state.Members, func(member Member) bool { return member.ID == human && member.Can(RoleAdmin) }) {
		return errors.New("accepting member hosts requires an admin or owner")
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, member := range state.Members {
		if member.ID != memberID || member.Kind != MemberAgent {
			continue
		}
		if slices.ContainsFunc(member.Hosts, func(known string) bool { return strings.EqualFold(strings.TrimSuffix(known, "."), host) }) {
			return nil
		}
		member.Hosts = append(member.Hosts, host)
		body, err := json.Marshal(member)
		if err != nil {
			return err
		}
		_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: MemberUpdated, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Payload: body})
		return err
	}
	return errors.New("member is not an agent in this group")
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
