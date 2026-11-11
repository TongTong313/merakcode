package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func (e *Engine) groupLookup(groupID event.ID) tool.Tool {
	return remoteLookupTool{Tool: e.localGroupLookup(groupID), engine: e, group: groupID}
}

func (e *Engine) localGroupLookup(groupID event.ID) tool.Tool {
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
			card, err := e.Tasks.Get(ctx, event.ID(parts[2]))
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
			fact, err := e.store.Get(ctx, event.ID(parts[0]))
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
			facts, err := e.store.Read(ctx, event.Stream("session:"+parts[0]), start, 64)
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
			doc, err := e.store.Fetch(ctx, "blob", parts[0])
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
			doc, err := e.store.Fetch(ctx, "shared", parts[1]+"/"+parts[2])
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

func (e *Engine) readGroupDoc(groupID event.ID) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "read_doc", Description: "Read a shared document in the current group, optionally selecting one-based inclusive lines.", Effect: tool.EffectRead, Input: json.RawMessage(`{"type":"object","properties":{"key":{"type":"string"},"startLine":{"type":"integer","minimum":1},"endLine":{"type":"integer","minimum":1}},"required":["key"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Key   string `json:"key"`
			Start *int   `json:"startLine"`
			End   *int   `json:"endLine"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Key == "" || strings.ContainsAny(input.Key, "/\\?#\x00") {
			return nil, errors.New("invalid shared document key")
		}
		args := map[string]any{"ref": "mrk://doc/shared/" + string(groupID) + "/" + url.PathEscape(input.Key)}
		if input.Start != nil {
			args["startLine"] = *input.Start
		}
		if input.End != nil {
			args["endLine"] = *input.End
		}
		call.Input, _ = json.Marshal(args)
		result, err := e.groupLookup(groupID).Run(ctx, call)
		if err != nil {
			return nil, err
		}
		if result.IsError {
			return nil, errors.New("shared document is unavailable or its line range is invalid")
		}
		return result.Parts[0].Text, nil
	}}
}

func (e *Engine) memberMemoryOwners(ctx context.Context, directory string, scope event.Scope, member event.ID) []memory.Owner {
	owners := []memory.Owner{}
	if scope.Group != "" {
		if project, err := e.executionProject(ctx, scope, directory); err == nil {
			directory = project
		}
		owners = append(owners, memory.Owner{Scope: memory.ScopeGroup, ID: scope.Group})
	}
	groupID, memberID := e.executionSource(scope, member)
	member = memberID
	if member != "" {
		owners = append(owners, memory.Owner{Scope: memory.ScopeMember, ID: member})
	}
	owners = append(owners, memory.ProjectOwner(directory))
	if groupID != "" && member != "" {
		m, err := e.groupMember(ctx, groupID, member)
		if err != nil {
			return nil
		}
		p, err := e.memberAgent(ctx, m)
		if err != nil {
			return nil
		}
		if p.Memory != nil {
			owners = slices.DeleteFunc(owners, func(o memory.Owner) bool { return !slices.Contains(p.Memory, o.Scope) })
		}
	}
	return owners
}

// groupLeader returns the roster entry of the Leader of a group.
func (e *Engine) groupLeader(ctx context.Context, groupID event.ID) (group.Member, error) {
	state, err := e.Groups.Get(ctx, groupID)
	if err != nil {
		return group.Member{}, err
	}
	return e.groupMember(ctx, groupID, state.Group.Leader)
}

// leaderActor is the Leader of the group of a task, as the actor of what it does to the task.
func (e *Engine) leaderActor(ctx context.Context, card task.Card) event.Actor {
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		return event.Actor{Kind: event.ActorAgent}
	}
	return event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
}

func (e *Engine) leads(ctx context.Context, card task.Card, member event.ID) bool {
	state, err := e.Groups.Get(ctx, card.Group)
	return err == nil && state.Group.Leader != "" && state.Group.Leader == member
}

// dropFormerLeaders takes the Leader agents that are not the Leader of the group out of the roster.
func (e *Engine) dropFormerLeaders(ctx context.Context, g group.Group) {
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil {
		return
	}
	for _, member := range state.Members {
		if member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader && member.ID != g.Leader {
			_ = e.Groups.RemoveFormerLeader(ctx, g.ID, member.ID)
		}
	}
}
