package group

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

// Error is a failure about the roster of a group, with the MRK code that names it.
type Error struct {
	Code string
	Err  error
}

func (e *Error) Error() string { return e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

func coded(code, text string) error { return &Error{Code: code, Err: errors.New(text)} }

func leaders(members []Member) []Member {
	var result []Member
	for _, member := range members {
		if member.Kind == MemberAgent && member.AgentRole == AgentLeader {
			result = append(result, member)
		}
	}
	return result
}

// checkLeader makes sure a roster has exactly one Leader agent and that it is the Leader of the group. An empty Leader
// of the group is filled in with the one Leader of the roster.
func checkLeader(g *Group, members []Member) error {
	found := leaders(members)
	switch {
	case len(found) == 0:
		return coded(errorcode.GroupLeaderMissing, "a group needs a Leader agent")
	case len(found) > 1:
		return coded(errorcode.GroupLeaderMultiple, "a group has exactly one Leader")
	}
	if g.Leader == "" {
		g.Leader = found[0].ID
	}
	if g.Leader != found[0].ID {
		return coded(errorcode.LeaderAgentRequired, "the Leader of a group must be its Leader member")
	}
	return nil
}

// ReplaceLeader changes the Leader in one step: the new Leader joins the roster and becomes the Leader of the group. The
// former Leader stays until the handover of its thread is complete, because the summary is written with its agent; the
// engine then calls RemoveFormerLeader. Only the owner may do it.
func (m *Manager) ReplaceLeader(ctx context.Context, id, human event.ID, next Member) (Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return Group{}, err
	}
	var actor Member
	for _, member := range state.Members {
		if member.ID == human {
			actor = member
		}
	}
	if !actor.Can(RoleOwner) {
		return Group{}, errors.New("changing the Leader requires the owner")
	}
	if next.Kind != MemberAgent || next.AgentRole != AgentLeader {
		return Group{}, coded(errorcode.LeaderAgentRequired, "the Leader of a group must be a Leader member")
	}
	if next.ID == "" {
		next.ID = m.newID()
	}
	next.Group, next.Status = id, Idle
	next.Current, next.Queue = "", nil
	if err := m.emit(ctx, id, MemberAdded, next); err != nil {
		return Group{}, err
	}
	state.Group.Leader = next.ID
	body, err := json.Marshal(state.Group)
	if err != nil {
		return Group{}, err
	}
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: Updated, Actor: event.Actor{Kind: event.ActorHuman, ID: human}, Payload: body})
	return state.Group, err
}

// RemoveFormerLeader takes a Leader agent that is no longer the Leader of the group out of the roster. The engine calls
// it when the handover of the Leader thread is complete.
func (m *Manager) RemoveFormerLeader(ctx context.Context, id, memberID event.ID) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return err
	}
	if memberID == state.Group.Leader {
		return nil
	}
	for _, member := range state.Members {
		if member.ID != memberID {
			continue
		}
		if member.Kind != MemberAgent || member.AgentRole != AgentLeader {
			return errors.New("only a former Leader leaves the roster this way")
		}
		body, _ := json.Marshal(member)
		_, err := m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: MemberRemoved, Actor: event.Actor{Kind: event.ActorAgent}, Payload: body})
		return err
	}
	return nil
}
