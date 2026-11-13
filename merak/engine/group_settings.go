package engine

import (
	"context"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
)

func (e *Engine) UpdateGroup(ctx context.Context, id, human event.ID, change group.Update) (group.Group, error) {
	if change.Settings != nil {
		if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), change.Settings.Triggers...)); err != nil {
			return group.Group{}, err
		}
	}
	if change.Leader != nil {
		return e.replaceLeader(ctx, id, human, *change.Leader)
	}
	if change.Project != nil {
		state, err := e.Groups.Get(ctx, id)
		if err != nil {
			return group.Group{}, err
		}
		if filepath.Clean(change.Project.Directory) != filepath.Clean(state.Group.Project.Directory) {
			moved, err := e.moveGroup(ctx, state.Group, change.Project.Directory, human)
			if err != nil {
				return group.Group{}, err
			}
			change.Project = nil
			if change.Settings == nil && change.Brief == nil {
				return moved, nil
			}
		}
	}
	return e.Groups.Update(ctx, id, human, change)
}

// replaceLeader makes an agent the Leader of the group. Any agent that can lead may take the seat; the former Leader leaves
// the roster, and the work of its thread is handed over to the new one.
func (e *Engine) replaceLeader(ctx context.Context, id, human, agentID event.ID) (group.Group, error) {
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	member := group.Member{Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: agentID, Owner: human}
	configured, _, err := e.loadAgent(ctx, member)
	if err != nil {
		return group.Group{}, err
	}
	member.Name = configured.Name
	member, err = e.prepareAgentMember(ctx, member, true)
	if err != nil {
		return group.Group{}, err
	}
	return e.Groups.ReplaceLeader(ctx, id, human, member)
}
