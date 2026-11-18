package enginetest

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func EnterGoalIntegration(t *testing.T, ctx context.Context, e *engine.Engine, id event.ID) {
	t.Helper()
	card, err := e.Task(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for card.Parent != "" {
		card, err = e.Task(ctx, card.Parent)
		if err != nil {
			t.Fatal(err)
		}
	}
	state, err := e.Group(ctx, card.Group)
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
	if card.Phase == task.PhasePlanning {
		if err := e.UpdateTask(ctx, card.ID, task.Update{Phase: task.PhaseDoing}, actor); err != nil {
			t.Fatal(err)
		}
	}
	if card.Phase == task.PhasePlanning || card.Phase == task.PhaseDoing {
		if err := e.UpdateTask(ctx, card.ID, task.Update{Phase: task.PhaseIntegrating}, actor); err != nil {
			t.Fatal(err)
		}
	}
}

func WaitGoalPhase(t *testing.T, ctx context.Context, e *engine.Engine, id event.ID, phase task.Phase) {
	t.Helper()
	for {
		card, err := e.Task(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if card.Phase == phase {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("phase=%s want=%s: %v", card.Phase, phase, ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
}
