package engine

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
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
	return e.Groups.Update(ctx, id, human, change)
}

// replaceLeader makes an agent the Leader of the group. The agent must have the Leader role; the former Leader leaves
// the roster, and the work of its thread is handed over to the new one.
func (e *Engine) replaceLeader(ctx context.Context, id, human, agentID event.ID) (group.Group, error) {
	e.agentMu.Lock()
	defer e.agentMu.Unlock()
	member := group.Member{Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: agentID, Owner: human}
	configured, _, err := e.loadAgent(ctx, member)
	if err != nil {
		return group.Group{}, err
	}
	if configured.Role != agent.Leader {
		return group.Group{}, coded(errorcode.LeaderAgentRequired, errors.New("the Leader of a group must be a Leader agent"))
	}
	member.Name = configured.Name
	member, err = e.prepareAgentMember(ctx, member, true)
	if err != nil {
		return group.Group{}, err
	}
	return e.Groups.ReplaceLeader(ctx, id, human, member)
}
