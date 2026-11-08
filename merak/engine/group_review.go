package engine

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func (e *Engine) ReviewTask(ctx context.Context, id, human event.ID, decision, feedback string) error {
	card, err := e.Tasks.Get(ctx, id)
	if err != nil {
		return err
	}
	if decision == "approve" && card.Workspace == "folder" {
		for _, claim := range card.Claims {
			if claim.Report != nil && len(claim.Report.Artifacts) != len(claim.Published) {
				return errors.New("declared artifacts must be published before approval")
			}
		}
	}
	if err := e.Tasks.Review(ctx, id, task.ReviewResult{Human: human, Decision: decision, Feedback: feedback}); err != nil {
		return err
	}
	if card.PlanPending {
		return nil
	}
	if decision == "approve" && card.Parent == "" && card.Phase == task.PhaseReview {
		return e.finishGoal(ctx, card.Group, card.ID)
	}
	if decision == "approve" {
		card, err := e.Tasks.Get(ctx, id)
		if err != nil {
			return err
		}
		pending := false
		for _, claim := range card.Claims {
			if card.Workspace != "worktree" || claim.Workspace == "" || claim.Integrated != "" {
				continue
			}
			if _, err := e.requestMerge(ctx, card, claim.ID); err != nil {
				return err
			}
			pending = true
		}
		if pending {
			return nil
		}
		return e.Tasks.Close(ctx, id, task.Done)
	}
	return nil
}
