package group

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// RenameMember gives a member another name in this group. The name is what people @ in the chat, so it has no spaces
// or at signs and no other member of the group may have it. Only an admin or an owner can rename.
func (m *Manager) RenameMember(ctx context.Context, id, human, memberID event.ID, name string) (Member, error) {
	name = strings.TrimSpace(name)
	if name == "" || strings.ContainsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || r == '@' }) {
		return Member{}, errors.New("a member name needs text without spaces or @")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return Member{}, err
	}
	var actor, target Member
	for _, member := range state.Members {
		if member.ID == human {
			actor = member
		}
		if member.ID == memberID {
			target = member
		}
		if member.ID != memberID && strings.EqualFold(member.Name, name) {
			return Member{}, errors.New("another member already has this name")
		}
	}
	if !actor.Can(RoleAdmin) || target.ID == "" {
		return Member{}, errors.New("member cannot be renamed")
	}
	target.Name = name
	body, err := json.Marshal(target)
	if err != nil {
		return Member{}, err
	}
	if _, err := m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: MemberUpdated, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Payload: body}); err != nil {
		return Member{}, err
	}
	return target, nil
}
