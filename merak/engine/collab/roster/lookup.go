package roster

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Roster) Group(ctx context.Context, id event.ID) (group.State, error) {
	return domain.groups.Get(ctx, id)
}

func (domain *Roster) ListGroups(ctx context.Context, human event.ID) ([]group.Group, error) {
	return domain.groups.List(ctx, human)
}

func (domain *Roster) LocalGroupLookup(groupID event.ID) tool.Tool {
	return tool.Lookup{MaxBytes: 50 * 1024, Resolve: func(ctx context.Context, ref *url.URL) ([]byte, error) {
		if groupID == "" {
			return nil, errors.New("group reference requires a group")
		}
		parts := strings.Split(strings.TrimPrefix(ref.Path, "/"), "/")
		if ref.Fragment != "" && ref.Host != "session" {
			return nil, errors.New("unexpected reference fragment")
		}
		switch ref.Host {
		case "group":
			if len(parts) != 3 || parts[0] != string(groupID) || parts[1] != "task" {
				break
			}
			card, err := domain.tasks.Get(ctx, event.ID(parts[2]))
			if err != nil {
				return nil, err
			}
			if card.Group != groupID {
				break
			}
			return json.Marshal(card)
		case "event":
			if len(parts) != 1 {
				break
			}
			fact, err := domain.core.Store.Get(ctx, event.ID(parts[0]))
			if err != nil {
				return nil, err
			}
			if fact.Scope.Group != groupID {
				break
			}
			return json.Marshal(fact)
		case "session":
			if len(parts) != 1 {
				break
			}
			start := uint64(1)
			if ref.Fragment != "" {
				var err error
				start, err = strconv.ParseUint(ref.Fragment, 10, 64)
				if err != nil || start == 0 {
					return nil, errors.New("invalid session sequence")
				}
			}
			facts, err := domain.core.Store.Read(ctx, event.Stream("session:"+parts[0]), start, 64)
			if err != nil {
				return nil, err
			}
			if len(facts) == 0 {
				return nil, store.ErrNotFound
			}
			for _, fact := range facts {
				if fact.Scope.Group != groupID {
					return nil, errors.New("reference is outside this group")
				}
			}
			return json.Marshal(facts)
		case "blob":
			if len(parts) != 1 {
				break
			}
			doc, err := domain.core.Store.Fetch(ctx, "blob", parts[0])
			if err != nil {
				return nil, err
			}
			if doc.Meta["group"] != string(groupID) {
				break
			}
			return doc.Body, nil
		case "doc":
			if len(parts) != 3 || parts[0] != "shared" || parts[1] != string(groupID) || parts[2] == "" {
				break
			}
			doc, err := domain.core.Store.Fetch(ctx, "shared", parts[1]+"/"+parts[2])
			if err != nil {
				return nil, err
			}
			if doc.Meta["group"] != string(groupID) {
				break
			}
			return doc.Body, nil
		}
		return nil, errors.New("reference is outside this group or unsupported")
	}}
}

func (domain *Roster) MemberMemoryOwners(ctx context.Context, directory string, scope event.Scope, member event.ID) []memory.Owner {
	owners := []memory.Owner{}
	if scope.Group != "" {
		if project, err := domain.execution.ExecutionProject(ctx, scope, directory); err == nil {
			directory = project
		}
		owners = append(owners, memory.Owner{Scope: memory.ScopeGroup, ID: scope.Group})
	}
	groupID, memberID := domain.execution.ExecutionSource(scope, member)
	member = memberID
	if member != "" {
		owners = append(owners, memory.Owner{Scope: memory.ScopeMember, ID: member})
	}
	owners = append(owners, memory.ProjectOwner(directory))
	if groupID != "" && member != "" {
		m, err := domain.GroupMember(ctx, groupID, member)
		if err != nil {
			return nil
		}
		p, err := domain.MemberAgent(ctx, m)
		if err != nil {
			return nil
		}
		if p.Memory != nil {
			owners = slices.DeleteFunc(owners, func(o memory.Owner) bool { return !slices.Contains(p.Memory, o.Scope) })
		}
	}
	return owners
}

// GroupLeader returns the roster entry of the Leader of a group.
func (domain *Roster) GroupLeader(ctx context.Context, groupID event.ID) (group.Member, error) {
	state, err := domain.groups.Get(ctx, groupID)
	if err != nil {
		return group.Member{}, err
	}
	return domain.GroupMember(ctx, groupID, state.Group.Leader)
}

// LeaderActor is the Leader of the group of a task, as the actor of what it does to the task.
func (domain *Roster) LeaderActor(ctx context.Context, card task.Card) event.Actor {
	state, err := domain.groups.Get(ctx, card.Group)
	if err != nil {
		return event.Actor{Kind: event.ActorAgent}
	}
	return event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
}

func (domain *Roster) Leads(ctx context.Context, card task.Card, member event.ID) bool {
	state, err := domain.groups.Get(ctx, card.Group)
	return err == nil && state.Group.Leader != "" && state.Group.Leader == member
}

// DropFormerLeaders takes the Leader agents that are not the Leader of the group out of the roster.
func (domain *Roster) DropFormerLeaders(ctx context.Context, g group.Group) {
	state, err := domain.groups.Get(ctx, g.ID)
	if err != nil {
		return
	}
	for _, member := range state.Members {
		if member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader && member.ID != g.Leader {
			_ = domain.groups.RemoveFormerLeader(ctx, g.ID, member.ID)
		}
	}
}
