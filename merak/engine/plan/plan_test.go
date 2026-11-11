package plan_test

import (
	"errors"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestAPlanMovesThroughDraftReviewExecutionAndDoneWithARevisionThatGuardsEdits(t *testing.T) {
	ctx := t.Context()
	plans := plan.New(memory.New())

	if _, err := plans.Get(ctx, "root"); !errors.Is(err, plan.ErrNone) {
		t.Fatalf("a session without a plan: %v", err)
	}
	written, err := plans.Write(ctx, "root", "# Plan\n1. Read\n2. Change")
	if err != nil || written.Status != plan.Review || written.Revision != 1 || written.Content != "# Plan\n1. Read\n2. Change" {
		t.Fatalf("written=%+v err=%v", written, err)
	}
	if _, err := plans.Save(ctx, "root", "# Plan\n1. Read\n2. Change\n3. Test", 0); !errors.Is(err, plan.ErrStale) {
		t.Fatalf("a save with an old revision: %v", err)
	}
	saved, err := plans.Save(ctx, "root", "# Plan\n1. Read\n2. Change\n3. Test", 1)
	if err != nil || saved.Revision != 2 || saved.Status != plan.Review {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	if _, err := plans.Save(ctx, "root", "   ", 2); err == nil {
		t.Fatal("an empty plan was saved")
	}

	run, err := plans.Execute(ctx, "root")
	if err != nil || run.Snapshot != saved.Content || run.Plan.Status != plan.Executing {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if _, err := plans.Save(ctx, "root", "A change while it runs", 2); err != nil {
		t.Fatalf("a plan stays editable while it runs: %v", err)
	}
	current, _ := plans.Get(ctx, "root")
	if current.Snapshot != saved.Content || current.Content != "A change while it runs" {
		t.Fatalf("the execution must keep its snapshot: %+v", current)
	}
	if _, err := plans.Execute(ctx, "root"); !errors.Is(err, plan.ErrState) {
		t.Fatalf("a plan that is running was executed again: %v", err)
	}
	done, err := plans.Finish(ctx, "root")
	if err != nil || done.Status != plan.Done {
		t.Fatalf("done=%+v err=%v", done, err)
	}
	if _, err := plans.Stop(ctx, "root"); !errors.Is(err, plan.ErrState) {
		t.Fatalf("a finished plan was stopped: %v", err)
	}
}

func TestAnExecutingPlanCanBeStoppedAndAWrittenPlanReplacesTheOldOne(t *testing.T) {
	ctx := t.Context()
	plans := plan.New(memory.New())
	if _, err := plans.Write(ctx, "root", "First"); err != nil {
		t.Fatal(err)
	}
	if _, err := plans.Execute(ctx, "root"); err != nil {
		t.Fatal(err)
	}
	stopped, err := plans.Stop(ctx, "root")
	if err != nil || stopped.Status != plan.Stopped {
		t.Fatalf("stopped=%+v err=%v", stopped, err)
	}
	again, err := plans.Write(ctx, "root", "Second")
	if err != nil || again.Status != plan.Review || again.Content != "Second" || again.Revision != 2 {
		t.Fatalf("a new plan after a stopped one: %+v err=%v", again, err)
	}
	if _, err := plans.Finish(ctx, "root"); !errors.Is(err, plan.ErrState) {
		t.Fatalf("a plan that was never executed finished: %v", err)
	}
}
