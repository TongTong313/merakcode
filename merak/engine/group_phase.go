package engine

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"slices"
)

func (e *Engine) setPhaseTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "set_phase", Description: "Set this top-level task's phase. Planning may require human approval before doing. Integrating requires completed reports. Human review controls delivery.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string","description":"The goal to change; optional while exactly one goal is open"},"phase":{"type":"string","enum":["planning","doing","integrating","stalled"]}},"required":["phase"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID   `json:"task"`
			Phase task.Phase `json:"phase"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if input.Phase != task.PhasePlanning && input.Phase != task.PhaseDoing && input.Phase != task.PhaseIntegrating && input.Phase != task.PhaseStalled {
			return nil, errors.New("a supported phase is required")
		}
		id, err := e.phaseTarget(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		if err := e.Tasks.SetPhase(ctx, id, input.Phase, event.Actor{Kind: event.ActorAgent, ID: thread.Leader}); err != nil {
			return nil, err
		}
		if err := e.advancePhase(ctx, event.Event{Type: task.PhaseChanged, Scope: event.Scope{Task: id}}); err != nil {
			return nil, err
		}
		return e.Tasks.Get(ctx, id)
	}}
}

// phaseTarget names the goal whose phase changes: the one the Leader gave, or the only open goal of the group.
func (e *Engine) phaseTarget(ctx context.Context, groupID event.ID, thread *leader.Thread, named event.ID) (event.ID, error) {
	if named != "" {
		card, err := e.scopedTask(ctx, groupID, thread, named)
		if err != nil {
			return "", err
		}
		return e.taskRoot(ctx, card)
	}
	cards, err := e.Tasks.List(ctx, groupID)
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

func (e *Engine) advancePhase(ctx context.Context, fact event.Event) error {
	switch fact.Type {
	case task.PhaseChanged, task.Updated, task.Reported, task.Closed:
	default:
		return nil
	}
	if fact.Scope.Task == "" {
		return nil
	}
	card, err := e.Tasks.Get(ctx, fact.Scope.Task)
	if err != nil {
		return err
	}
	if fact.Type == task.Closed && (card.Status == task.Failed || card.Status == task.Cancelled) {
		cards, err := e.Tasks.List(ctx, card.Group)
		if err != nil {
			return err
		}
		for _, dependent := range cards {
			if !slices.Contains(dependent.Deps, card.ID) {
				continue
			}
			root, err := e.taskRoot(ctx, dependent)
			if err != nil {
				return err
			}
			goal, err := e.Tasks.Get(ctx, root)
			if err != nil {
				return err
			}
			if goal.Phase == task.PhaseDone || goal.Phase == task.PhaseCancelled {
				continue
			}
			if err := e.Tasks.SetPhase(ctx, root, task.PhaseStalled, e.leaderActor(ctx, goal)); err != nil {
				return err
			}
		}
	}
	root, err := e.taskRoot(ctx, card)
	if err != nil {
		return err
	}
	goal, err := e.Tasks.Get(ctx, root)
	if err != nil {
		return err
	}
	if goal.Phase == task.PhaseReview && (!goal.Review || goal.LastReview != nil && goal.LastReview.Decision == "approve" && goal.LastReview.Phase == task.PhaseReview) {
		state, err := e.Groups.Get(ctx, goal.Group)
		if err != nil {
			return err
		}
		if !state.Group.Settings.ReviewRequired() {
			return e.finishGoal(ctx, goal.Group, goal.ID)
		}
	}
	if goal.Phase != task.PhaseIntegrating {
		return nil
	}
	err = e.Tasks.SetPhase(ctx, goal.ID, task.PhaseReview, e.leaderActor(ctx, goal))
	if errors.Is(err, task.ErrState) {
		return nil
	}
	if err == nil {
		return e.advancePhase(ctx, event.Event{Type: task.PhaseChanged, Scope: event.Scope{Task: goal.ID}})
	}
	return err
}
