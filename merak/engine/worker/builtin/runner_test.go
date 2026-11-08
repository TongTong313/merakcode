package builtin_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
)

func TestBackgroundRunReturnsBeforeCompletionAndDeliversOneReport(t *testing.T) {
	release := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	bus := event.NewBus(storage.New(), time.Now, event.NewID)
	provider := fake.New(t, fake.Reply{Text: "Research result", Hold: release})
	runner := builtin.New(ctx, bus, event.NewID, func(ctx context.Context, id event.ID, prompt string) (loop.Outcome, error) {
		conversation := loop.Loop{Model: provider, Bus: bus, Tools: tool.NewPool("worker.readonly")}
		return conversation.RunTurn(ctx, &session.State{ID: id}, loop.Input{Parts: []model.Part{{Text: prompt}}})
	})
	defer runner.Close()
	id, err := runner.Spawn(ctx, "Research")
	if err != nil || id == "" {
		t.Fatalf("id=%q error=%v", id, err)
	}
	if len(runner.Poll()) != 0 {
		t.Fatal("unfinished child produced a report")
	}
	wait := make(chan error, 1)
	go func() { wait <- runner.Wait(ctx, id) }()
	select {
	case <-wait:
		t.Fatal("wait returned before completion")
	default:
	}
	close(release)
	if err := <-wait; err != nil {
		t.Fatal(err)
	}
	inputs := runner.Poll()
	if len(inputs) != 1 || inputs[0].Child == nil || inputs[0].Child.ID != id || inputs[0].Child.Report[0].Text != "Research result" {
		t.Fatalf("inputs=%+v", inputs)
	}
	if len(runner.Poll()) != 0 {
		t.Fatal("child report was delivered twice")
	}
}

func TestCancelStopsChildrenWithoutPreventingAFutureChild(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started := make(chan struct{})
	provider := fake.New(t, fake.Reply{Text: "Cancelled", Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }}, fake.Reply{Text: "New report"})
	bus := event.NewBus(storage.New(), time.Now, event.NewID)
	runner := builtin.New(ctx, bus, event.NewID, func(ctx context.Context, id event.ID, prompt string) (loop.Outcome, error) {
		conversation := loop.Loop{Model: provider, Bus: bus, Tools: tool.NewPool("readonly")}
		return conversation.RunTurn(ctx, &session.State{ID: id}, loop.Input{Parts: []model.Part{{Text: prompt}}})
	})
	defer runner.Close()
	id, err := runner.Spawn(ctx, "First")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	runner.Cancel()
	if err := runner.Wait(ctx, id); err != nil {
		t.Fatal(err)
	}
	id, err = runner.Spawn(ctx, "Next")
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Wait(ctx, id); err != nil {
		t.Fatal(err)
	}
	inputs := runner.Poll()
	if len(inputs) != 2 || inputs[1].Child.Report[0].Text != "New report" {
		t.Fatalf("inputs=%+v", inputs)
	}
}

func TestChangingTheLauncherOnlyAffectsFutureChildren(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	release := make(chan struct{})
	bus := event.NewBus(storage.New(), time.Now, event.NewID)
	launch := func(provider model.Provider) func(context.Context, event.ID, string) (loop.Outcome, error) {
		return func(ctx context.Context, id event.ID, prompt string) (loop.Outcome, error) {
			conversation := loop.Loop{Model: provider, Bus: bus, Tools: tool.NewPool("readonly")}
			return conversation.RunTurn(ctx, &session.State{ID: id}, loop.Input{Parts: []model.Part{{Text: prompt}}})
		}
	}
	runner := builtin.New(ctx, bus, event.NewID, launch(fake.New(t, fake.Reply{Text: "Original", Hold: release})))
	defer runner.Close()
	first, err := runner.Spawn(ctx, "First")
	if err != nil {
		t.Fatal(err)
	}
	runner.SetRun(launch(fake.New(t, fake.Reply{Text: "Changed"})))
	second, err := runner.Spawn(ctx, "Second")
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Wait(ctx, second); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := runner.Wait(ctx, first); err != nil {
		t.Fatal(err)
	}
	results := make(map[event.ID]string)
	for _, input := range runner.Poll() {
		results[input.Child.ID] = input.Child.Report[0].Text
	}
	if results[first] != "Original" || results[second] != "Changed" {
		t.Fatalf("child launcher changed after spawn: %v", results)
	}
}
