package coordinator

import (
	"context"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) UpdateGroup(ctx context.Context, id, human event.ID, change group.Update) (group.Group, error) {
	if change.Settings != nil {
		if _, err := leader.NewTriggers(append(leader.DefaultTriggers(), change.Settings.Triggers...)); err != nil {
			return group.Group{}, err
		}
	}
	if change.Leader != nil {
		return domain.replaceLeader(ctx, id, human, *change.Leader)
	}
	if change.Project != nil {
		state, err := domain.groups.Get(ctx, id)
		if err != nil {
			return group.Group{}, err
		}
		if filepath.Clean(change.Project.Directory) != filepath.Clean(state.Group.Project.Directory) {
			moved, err := domain.moveGroup(ctx, state.Group, change.Project.Directory, human)
			if err != nil {
				return group.Group{}, err
			}
			change.Project = nil
			if change.Settings == nil && change.Brief == nil {
				return moved, nil
			}
		}
	}
	return domain.groups.Update(ctx, id, human, change)
}

// replaceLeader makes an agent the Leader of the group. Any agent that can lead may take the seat; the former Leader leaves
// the roster, and the work of its thread is handed over to the new one.
func (domain *Coordinator) replaceLeader(ctx context.Context, id, human, agentID event.ID) (group.Group, error) {
	domain.registry.AgentMu.Lock()
	defer domain.registry.AgentMu.Unlock()
	member := group.Member{Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: agentID, Owner: human}
	configured, _, err := domain.roster.LoadAgent(ctx, member)
	if err != nil {
		return group.Group{}, err
	}
	member.Name = configured.Name
	member, err = domain.prepareAgentMember(ctx, member, true)
	if err != nil {
		return group.Group{}, err
	}
	return domain.groups.ReplaceLeader(ctx, id, human, member)
}

// ConfigureBoard sets how many days a finished task stays on the board and archives the ones that are already older
// without waiting for the next hourly pass, so every client sees the new setting at once.
func (domain *Coordinator) ConfigureBoard(autoArchiveDays int) {
	domain.board.Configure(autoArchiveDays)
	if domain.core.Ctx.Err() != nil {
		return
	}
	domain.core.Workers.Go(func() {
		if err := domain.board.ArchiveStale(domain.core.Ctx); err != nil && domain.core.Ctx.Err() == nil {
			domain.core.Logger.Warn("finished tasks could not be archived")
		}
	})
}
