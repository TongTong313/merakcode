// Package group stores local groups and their human and agent members.
package group

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type Kind string

const KindLocal Kind = "local"

type MemberKind string

const (
	MemberHuman MemberKind = "human"
	MemberAgent MemberKind = "agent"
)

type AgentRole string

const (
	AgentLeader AgentRole = "leader"
	AgentWorker AgentRole = "worker"
)

type Status string

const (
	Idle    Status = "idle"
	Busy    Status = "busy"
	Waiting Status = "waiting"
	Offline Status = "offline"
)

type Project struct {
	Directory string `json:"directory"`
}
type Brief struct {
	TargetBranch string `json:"targetBranch,omitempty"`
	Check        string `json:"check,omitempty"`
}
type Group struct {
	ID            event.ID `json:"id"`
	Kind          Kind     `json:"kind"`
	Name          string   `json:"name"`
	Project       Project  `json:"project"`
	DefaultLeader event.ID `json:"defaultLeader"`
	Brief         Brief    `json:"brief,omitempty"`
	Settings      Settings `json:"settings,omitempty"`
}
type Member struct {
	Unconfined bool       `json:"unconfined,omitempty"`
	Hosts      []string   `json:"hosts,omitempty"`
	ID         event.ID   `json:"id"`
	Group      event.ID   `json:"group"`
	Kind       MemberKind `json:"kind"`
	Name       string     `json:"name"`
	Role       string     `json:"role,omitempty"`
	AgentRole  AgentRole  `json:"agentRole,omitempty"`
	Owner      event.ID   `json:"owner,omitempty"`
	Profile    event.ID   `json:"profile,omitempty"`
	Status     Status     `json:"status"`
	Current    event.ID   `json:"current,omitempty"`
	Queue      []event.ID `json:"queue,omitempty"`
}
type State struct {
	Group   Group    `json:"group"`
	Members []Member `json:"members"`
}

const (
	Created       event.Type = "group.created"
	MemberAdded   event.Type = "member.added"
	MemberUpdated event.Type = "member.updated"
)

func init() {
	event.Register[State](Created)
	event.Register[Member](MemberAdded)
	event.Register[Member](MemberUpdated)
}

type Manager struct {
	mu    sync.Mutex
	store store.Store
	bus   *event.Bus
	newID func() event.ID
}

func New(storage store.Store, bus *event.Bus, newID func() event.ID) *Manager {
	return &Manager{store: storage, bus: bus, newID: newID}
}
func (m *Manager) Create(ctx context.Context, g Group, members []Member) (Group, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if g.Kind != KindLocal || strings.TrimSpace(g.Name) == "" || g.Project.Directory == "" {
		return Group{}, errors.New("a local group, name and project directory are required")
	}
	if g.ID == "" {
		g.ID = m.newID()
	}
	if _, err := m.get(ctx, g.ID); !errors.Is(err, store.ErrNotFound) {
		if err != nil {
			return Group{}, err
		}
		return Group{}, store.ErrConflict
	}
	copy := append([]Member(nil), members...)
	seen := map[event.ID]bool{}
	leader := false
	for i := range copy {
		member := &copy[i]
		if member.ID == "" {
			member.ID = m.newID()
		}
		if seen[member.ID] || !validMember(*member) {
			return Group{}, errors.New("invalid or duplicate group member")
		}
		seen[member.ID] = true
		member.Group, member.Status = g.ID, Idle
		member.Current, member.Queue = "", nil
		if member.ID == g.DefaultLeader && member.Kind == MemberAgent && member.AgentRole == AgentLeader {
			leader = true
		}
	}
	if !leader {
		return Group{}, errors.New("default leader must be a leader member of the group")
	}
	if err := validateSettings(g.Settings, copy); err != nil {
		return Group{}, err
	}
	humanIndex, humans := -1, 0
	for i, member := range copy {
		if member.Kind == MemberHuman {
			humanIndex, humans = i, humans+1
		}
	}
	if humans == 1 && copy[humanIndex].Role == "" {
		copy[humanIndex].Role = RoleOwner
	}
	if err := m.emit(ctx, g.ID, Created, State{Group: g, Members: copy}); err != nil {
		return Group{}, err
	}
	return g, nil
}
func validMember(member Member) bool {
	if strings.TrimSpace(member.Name) == "" {
		return false
	}
	if member.Kind == MemberHuman {
		return member.AgentRole == ""
	}
	return member.Kind == MemberAgent && (member.AgentRole == AgentLeader || member.AgentRole == AgentWorker)
}
func (m *Manager) AddMember(ctx context.Context, id event.ID, member Member) (Member, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.get(ctx, id)
	if err != nil {
		return Member{}, err
	}
	if !validMember(member) {
		return Member{}, errors.New("invalid group member")
	}
	if member.ID == "" {
		member.ID = m.newID()
	}
	for _, existing := range state.Members {
		if existing.ID == member.ID {
			return Member{}, store.ErrConflict
		}
	}
	if member.Kind == MemberHuman && member.Role == "" {
		first := true
		for _, existing := range state.Members {
			if existing.Kind == MemberHuman {
				first = false
				break
			}
		}
		if first {
			member.Role = RoleOwner
		}
	}
	member.Group, member.Status = id, Idle
	member.Current, member.Queue = "", nil
	if err := m.emit(ctx, id, MemberAdded, member); err != nil {
		return Member{}, err
	}
	return member, nil
}
func (m *Manager) Get(ctx context.Context, id event.ID) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(ctx, id)
}
func (m *Manager) get(ctx context.Context, id event.ID) (State, error) {
	var state State
	stream := event.Stream("group:" + id)
	var sequence uint64
	for {
		facts, err := m.store.Read(ctx, stream, sequence+1, 128)
		if err != nil {
			return state, err
		}
		for _, fact := range facts {
			sequence = fact.Seq
			switch fact.Type {
			case Created:
				if err := json.Unmarshal(fact.Payload, &state); err != nil {
					return state, err
				}
			case MemberAdded:
				member, err := event.Decode[Member](fact)
				if err != nil {
					return state, err
				}
				state.Members = append(state.Members, member)
			case MemberUpdated:
				member, err := event.Decode[Member](fact)
				if err != nil {
					return state, err
				}
				for i := range state.Members {
					if state.Members[i].ID == member.ID {
						state.Members[i] = member
						break
					}
				}
			case Updated:
				updated, err := event.Decode[Group](fact)
				if err != nil {
					return state, err
				}
				state.Group = updated
			}
		}
		if len(facts) < 128 {
			break
		}
	}
	if state.Group.ID == "" {
		return state, store.ErrNotFound
	}
	m.bus.Resume(stream, sequence)
	return state, nil
}
func (m *Manager) emit(ctx context.Context, id event.ID, kind event.Type, value any) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = m.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + id), Scope: event.Scope{Group: id}, Type: kind, Actor: event.Actor{Kind: event.ActorHuman}, Payload: body})
	return err
}
