package engine

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/task"
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
