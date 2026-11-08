package loop_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
)

func TestHumanInputPreemptsAnInFlightModelStep(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started := make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }},
		fake.Reply{Text: "Updated result", Expect: func(req model.Request) error {
			if !strings.Contains(fmt.Sprint(req.Messages), "Use the new requirement") {
				return fmt.Errorf("human input missing from resumed request")
			}
			return nil
		}},
	)
	bus := event.NewBus(nil, time.Now, event.NewID)
	facts, stop := bus.Subscribe(event.Filter{})
	defer stop()
	state := session.State{ID: "session"}
	adapter := builtin.Adapter{Bus: bus, Execute: func(ctx context.Context, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
		runner := loop.Loop{Bus: bus, Model: provider, Steer: steer}
		return runner.RunTurn(ctx, &state, loop.Input{Parts: []model.Part{{Text: a.Packet}}})
	}}
	run, err := adapter.Start(ctx, worker.Assignment{Session: state.ID, Claim: task.Claim{ID: "claim"}, Packet: "Original requirement"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := run.Send(ctx, loop.Input{Actor: event.Actor{Kind: event.ActorHuman, ID: "human"}, Cause: "human-message", Parts: []model.Part{{Text: "Use the new requirement"}}}); err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "Updated result" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	stop()
	preempted, finished := 0, 0
	for fact := range facts {
		if fact.Type == "turn.preempted" {
			preempted++
		}
		if fact.Type == loop.TurnFinished {
			finished++
		}
	}
	if preempted != 1 || finished != 1 || len(state.Open) != 0 {
		t.Fatalf("preempted=%d finished=%d open=%v", preempted, finished, state.Open)
	}
}

func TestQueuedAgentInputIsIncludedBeforeTheWorkerFinishes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Text: "Original result", Hold: release, Expect: func(model.Request) error { close(started); return nil }},
		fake.Reply{Text: "Updated result", Expect: func(req model.Request) error {
			if !strings.Contains(fmt.Sprint(req.Messages), "New report") {
				return fmt.Errorf("queued input missing")
			}
			return nil
		}},
	)
	bus := event.NewBus(nil, time.Now, event.NewID)
	adapter := builtin.Adapter{Bus: bus, Execute: func(ctx context.Context, a worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
		runner := loop.Loop{Bus: bus, Model: provider, Steer: steer}
		return runner.RunTurn(ctx, &session.State{ID: a.Session}, loop.Input{Parts: []model.Part{{Text: a.Packet}}})
	}}
	run, err := adapter.Start(ctx, worker.Assignment{Session: "session", Packet: "Original requirement"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := run.Send(ctx, loop.Input{Actor: event.Actor{Kind: event.ActorAgent}, Parts: []model.Part{{Text: "New report"}}}); err != nil {
		t.Fatal(err)
	}
	close(release)
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "Updated result" {
		t.Fatalf("queued input was lost: %+v %v", report, err)
	}
}
