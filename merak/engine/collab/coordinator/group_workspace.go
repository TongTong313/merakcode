package coordinator

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
)

func (domain *Coordinator) releaseGoalWorkspaces(ctx context.Context, goal task.Card) error {
	cards, err := domain.tasks.List(ctx, goal.Group)
	if err != nil {
		return err
	}
	for _, card := range cards {
		root, err := domain.roster.TaskRoot(ctx, card)
		if err != nil {
			return err
		}
		if root != goal.ID {
			continue
		}
		for _, claim := range card.Claims {
			if claim.Workspace == "" {
				continue
			}
			ws, err := domain.workspaces.Get(ctx, claim.Workspace)
			if err != nil {
				return err
			}
			if err := domain.workspaces.Release(ctx, ws); err != nil {
				return err
			}
		}
	}
	return nil
}

// BindTask gives a task that no group has taken to an existing local group, on behalf of one of its humans.
func (domain *Coordinator) BindTask(ctx context.Context, groupID, taskID, human event.ID) (task.Card, error) {
	state, err := domain.groups.Get(ctx, groupID)
	if err != nil {
		return task.Card{}, err
	}
	actor, err := domain.roster.GroupMember(ctx, groupID, human)
	if err != nil || !actor.Can(group.RoleMember) {
		return task.Card{}, task.ErrNotMember
	}
	card, err := domain.tasks.Get(ctx, taskID)
	if err != nil {
		return task.Card{}, err
	}
	if card.Group != "" {
		return task.Card{}, errorcode.Coded(errorcode.TaskAlreadyInGroup, task.ErrAlreadyBound)
	}
	if !folder.SameDirectory(card.Project, state.Group.Project.Directory) {
		if !actor.Can(group.RoleAdmin) {
			return task.Card{}, task.ErrNotMember
		}
		if state.Group, err = domain.moveGroup(ctx, state.Group, card.Project, human); err != nil {
			return task.Card{}, err
		}
	}
	kind, base, err := domain.workspaceFor(ctx, state.Group, card.Workspace, card.Base)
	if err != nil {
		return task.Card{}, err
	}
	return domain.tasks.Bind(ctx, taskID, groupID, kind, base, event.Actor{Kind: event.ActorHuman, ID: human})
}

// moveGroup makes another folder the workspace of a group that has no work running, and takes its unfinished tasks
// along. The Leader continues in a new session started in the new folder.
func (domain *Coordinator) moveGroup(ctx context.Context, g group.Group, directory string, human event.ID) (group.Group, error) {
	directory = registry.CanonicalDirectory(directory)
	if err := folder.Existing(directory); err != nil {
		return group.Group{}, errorcode.Coded(errorcode.WorkspaceInvalid, err)
	}
	working, err := domain.tasks.Working(ctx, g.ID)
	if err != nil {
		return group.Group{}, err
	}
	if working {
		return group.Group{}, errorcode.Coded(errorcode.GroupWorkspaceInUse, errors.New("the group has running or queued work"))
	}
	moved, err := domain.groups.Update(ctx, g.ID, human, group.Update{Project: &group.Project{Directory: directory}})
	if err != nil {
		return group.Group{}, err
	}
	base := ""
	if moved.Brief.TargetBranch != "" {
		if base, err = git.Commit(ctx, directory, "refs/heads/"+moved.Brief.TargetBranch); err != nil {
			return group.Group{}, err
		}
	}
	if err := domain.tasks.Retarget(ctx, g.ID, directory, base, event.Actor{Kind: event.ActorHuman, ID: human}); err != nil {
		return group.Group{}, err
	}
	return moved, nil
}
