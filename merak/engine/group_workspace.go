package engine

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

func (e *Engine) releaseGoalWorkspaces(ctx context.Context, goal task.Card) error {
	cards, err := e.Tasks.List(ctx, goal.Group)
	if err != nil {
		return err
	}
	for _, card := range cards {
		root, err := e.taskRoot(ctx, card)
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
			ws, err := e.Workspaces.Get(ctx, claim.Workspace)
			if err != nil {
				return err
			}
			if err := e.Workspaces.Release(ctx, ws); err != nil {
				return err
			}
		}
	}
	return nil
}

// BindTask gives a task that no group has taken to an existing local group, on behalf of one of its humans.
func (e *Engine) BindTask(ctx context.Context, groupID, taskID, human event.ID) (task.Card, error) {
	state, err := e.Groups.Get(ctx, groupID)
	if err != nil {
		return task.Card{}, err
	}
	actor, err := e.groupMember(ctx, groupID, human)
	if err != nil || !actor.Can(group.RoleMember) {
		return task.Card{}, task.ErrNotMember
	}
	card, err := e.Tasks.Get(ctx, taskID)
	if err != nil {
		return task.Card{}, err
	}
	if card.Group != "" {
		return task.Card{}, coded(errorcode.TaskAlreadyInGroup, task.ErrAlreadyBound)
	}
	if !workspace.SameDirectory(card.Project, state.Group.Project.Directory) {
		if !actor.Can(group.RoleAdmin) {
			return task.Card{}, task.ErrNotMember
		}
		if state.Group, err = e.moveGroup(ctx, state.Group, card.Project, human); err != nil {
			return task.Card{}, err
		}
	}
	kind, base, err := e.workspaceFor(ctx, state.Group, card.Workspace, card.Base)
	if err != nil {
		return task.Card{}, err
	}
	return e.Tasks.Bind(ctx, taskID, groupID, kind, base, event.Actor{Kind: event.ActorHuman, ID: human})
}

// moveGroup makes another folder the workspace of a group that has no work running, and takes its unfinished tasks
// along. The Leader continues in a new session started in the new folder.
func (e *Engine) moveGroup(ctx context.Context, g group.Group, directory string, human event.ID) (group.Group, error) {
	directory = canonicalDirectory(directory)
	if err := workspace.Existing(directory); err != nil {
		return group.Group{}, coded(errorcode.WorkspaceInvalid, err)
	}
	working, err := e.Tasks.Working(ctx, g.ID)
	if err != nil {
		return group.Group{}, err
	}
	if working {
		return group.Group{}, coded(errorcode.GroupWorkspaceInUse, errors.New("the group has running or queued work"))
	}
	moved, err := e.Groups.Update(ctx, g.ID, human, group.Update{Project: &group.Project{Directory: directory}})
	if err != nil {
		return group.Group{}, err
	}
	base := ""
	if moved.Brief.TargetBranch != "" {
		if base, err = git.Commit(ctx, directory, "refs/heads/"+moved.Brief.TargetBranch); err != nil {
			return group.Group{}, err
		}
	}
	if err := e.Tasks.Retarget(ctx, g.ID, directory, base, event.Actor{Kind: event.ActorHuman, ID: human}); err != nil {
		return group.Group{}, err
	}
	return moved, nil
}
