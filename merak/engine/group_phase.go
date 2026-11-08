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
	return groupTool{spec: tool.Spec{Name: "set_phase", Description: "Set this top-level task's phase. Planning may require human approval before doing. Integrating requires completed reports. Human review controls delivery.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"phase":{"type":"string","enum":["planning","doing","integrating","stalled"]}},"required":["phase"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Phase task.Phase `json:"phase"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		id := thread.Session.Scope.Task
		if id == "" || input.Phase != task.PhasePlanning && input.Phase != task.PhaseDoing && input.Phase != task.PhaseIntegrating && input.Phase != task.PhaseStalled {
			return nil, errors.New("a task thread and a supported phase are required")
		}
		if _, err := e.scopedTask(ctx, g.group.ID, thread, id); err != nil {
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
			if err := e.Tasks.SetPhase(ctx, root, task.PhaseStalled, event.Actor{Kind: event.ActorAgent, ID: goal.Leader}); err != nil {
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
	err = e.Tasks.SetPhase(ctx, goal.ID, task.PhaseReview, event.Actor{Kind: event.ActorAgent, ID: goal.Leader})
	if errors.Is(err, task.ErrState) {
		return nil
	}
	if err == nil {
		return e.advancePhase(ctx, event.Event{Type: task.PhaseChanged, Scope: event.Scope{Task: goal.ID}})
	}
	return err
}
