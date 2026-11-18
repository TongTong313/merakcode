package coordinator

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) setPhaseTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "set_phase", Description: "Set this top-level task's phase. Planning may require human approval before doing. Integrating requires completed reports. Human review controls delivery.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string","description":"The goal to change; optional while exactly one goal is open"},"phase":{"type":"string","enum":["planning","doing","integrating","stalled"]}},"required":["phase"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID   `json:"task"`
			Phase task.Phase `json:"phase"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Phase != task.PhasePlanning && input.Phase != task.PhaseDoing && input.Phase != task.PhaseIntegrating && input.Phase != task.PhaseStalled {
			return nil, errors.New("a supported phase is required")
		}
		id, err := domain.phaseTarget(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		if err := domain.tasks.SetPhase(ctx, id, input.Phase, event.Actor{Kind: event.ActorAgent, ID: thread.Leader}); err != nil {
			return nil, err
		}
		if err := domain.advancePhase(ctx, event.Event{Type: task.PhaseChanged, Scope: event.Scope{Task: id}}); err != nil {
			return nil, err
		}
		return domain.tasks.Get(ctx, id)
	}}
}

// phaseTarget names the goal whose phase changes: the one the Leader gave, or the only open goal of the group.
func (domain *Coordinator) phaseTarget(ctx context.Context, groupID event.ID, thread *leader.Thread, named event.ID) (event.ID, error) {
	if named != "" {
		card, err := domain.roster.ScopedTask(ctx, groupID, thread, named)
		if err != nil {
			return "", err
		}
		return domain.roster.TaskRoot(ctx, card)
	}
	cards, err := domain.tasks.List(ctx, groupID)
	if err != nil {
		return "", err
	}
	var open []event.ID
	for _, card := range cards {
		if card.Parent == "" && card.Phase != task.PhaseDone && card.Phase != task.PhaseCancelled {
			open = append(open, card.ID)
		}
	}
	if len(open) != 1 {
		return "", errors.New("name the goal: the group does not have exactly one open goal")
	}
	return open[0], nil
}

func (domain *Coordinator) advancePhase(ctx context.Context, fact event.Event) error {
	switch fact.Type {
	case task.PhaseChanged, task.Updated, task.Reported, task.Closed:
	default:
		return nil
	}
	if fact.Scope.Task == "" {
		return nil
	}
	card, err := domain.tasks.Get(ctx, fact.Scope.Task)
	if err != nil {
		return err
	}
	if fact.Type == task.Closed && (card.Status == task.Failed || card.Status == task.Cancelled) {
		cards, err := domain.tasks.List(ctx, card.Group)
		if err != nil {
			return err
		}
		for _, dependent := range cards {
			if !slices.Contains(dependent.Deps, card.ID) {
				continue
			}
			root, err := domain.roster.TaskRoot(ctx, dependent)
			if err != nil {
				return err
			}
			goal, err := domain.tasks.Get(ctx, root)
			if err != nil {
				return err
			}
			if goal.Phase == task.PhaseDone || goal.Phase == task.PhaseCancelled {
				continue
			}
			if err := domain.tasks.SetPhase(ctx, root, task.PhaseStalled, domain.roster.LeaderActor(ctx, goal)); err != nil {
				return err
			}
		}
	}
	root, err := domain.roster.TaskRoot(ctx, card)
	if err != nil {
		return err
	}
	goal, err := domain.tasks.Get(ctx, root)
	if err != nil {
		return err
	}
	if goal.Phase == task.PhaseReview && (!goal.Review || goal.LastReview != nil && goal.LastReview.Decision == "approve" && goal.LastReview.Phase == task.PhaseReview) {
		state, err := domain.groups.Get(ctx, goal.Group)
		if err != nil {
			return err
		}
		if !state.Group.Settings.ReviewRequired() {
			return domain.finishGoal(ctx, goal.Group, goal.ID)
		}
	}
	if goal.Phase != task.PhaseIntegrating {
		return nil
	}
	err = domain.tasks.SetPhase(ctx, goal.ID, task.PhaseReview, domain.roster.LeaderActor(ctx, goal))
	if errors.Is(err, task.ErrState) {
		return nil
	}
	if err == nil {
		return domain.advancePhase(ctx, event.Event{Type: task.PhaseChanged, Scope: event.Scope{Task: goal.ID}})
	}
	return err
}
