package engine_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func enterGoalIntegration(t *testing.T, ctx context.Context, e *engine.Engine, id event.ID) {
	t.Helper()
	card, err := e.Tasks.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	for card.Parent != "" {
		card, err = e.Tasks.Get(ctx, card.Parent)
		if err != nil {
			t.Fatal(err)
		}
	}
	state, err := e.Groups.Get(ctx, card.Group)
	if err != nil {
		t.Fatal(err)
	}
	actor := event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
	if card.Phase == task.PhasePlanning {
		if err := e.Tasks.SetPhase(ctx, card.ID, task.PhaseDoing, actor); err != nil {
			t.Fatal(err)
		}
	}
	if card.Phase == task.PhasePlanning || card.Phase == task.PhaseDoing {
		if err := e.Tasks.SetPhase(ctx, card.ID, task.PhaseIntegrating, actor); err != nil {
			t.Fatal(err)
		}
	}
}

func waitGoalPhase(t *testing.T, ctx context.Context, e *engine.Engine, id event.ID, phase task.Phase) {
	t.Helper()
	for {
		card, err := e.Tasks.Get(ctx, id)
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
