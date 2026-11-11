package leader_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestSchedulersWaitForEventsAndTheGroupThreadTakesEveryTask(t *testing.T) {
	var state leader.State
	for _, card := range []task.Card{{ID: "goal"}, {ID: "child", Parent: "goal"}} {
		body, _ := json.Marshal(card)
		if err := state.Apply(event.Event{Type: task.Created, Payload: body}); err != nil {
			t.Fatal(err)
		}
	}
	threads := leader.NewThreads(group.Group{ID: "group", Leader: "leader"}, &state, event.NewID)
	groupThread := threads.Route(event.Event{Scope: event.Scope{Group: "group"}})
	taskThread := threads.Route(event.Event{Scope: event.Scope{Group: "group", Task: "goal"}})
	childThread := threads.Route(event.Event{Scope: event.Scope{Group: "group", Task: "child"}})
	if groupThread.Key != "group" || taskThread != groupThread || childThread != groupThread || groupThread.Leader != "leader" {
		t.Fatal("thread attribution was lost")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got := make(chan event.Event, 1)
	go func() {
		fact, err := taskThread.Scheduler.Next(ctx)
		if err == nil {
			got <- fact
		}
	}()
	select {
	case fact := <-got:
		t.Fatalf("idle scheduler produced %+v", fact)
	case <-time.After(20 * time.Millisecond):
	}
	taskThread.Scheduler.Enqueue(event.Event{ID: "created", Type: task.Opened, Actor: event.Actor{Kind: event.ActorHuman}})
	taskThread.Scheduler.Enqueue(event.Event{ID: "reported", Type: task.Reported})
	select {
	case fact := <-got:
		if fact.ID != "created" {
			t.Fatalf("first=%+v", fact)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	fact, err := taskThread.Scheduler.Next(ctx)
	if err != nil || fact.ID != "reported" {
		t.Fatalf("next=%+v err=%v", fact, err)
	}
	wait, stop := context.WithTimeout(ctx, 20*time.Millisecond)
	defer stop()
	if _, err := taskThread.Scheduler.Next(wait); err == nil {
		t.Fatal("idle scheduler did not wait")
	}
}

func TestSchedulerBatchesHumanBurstsAndKeepsOnlyLatestProgress(t *testing.T) {
	scheduler := leader.NewScheduler()
	now := time.Now()
	for _, fact := range []event.Event{
		{ID: "progress-old", Type: task.Progressed, Scope: event.Scope{Task: "task"}, Payload: json.RawMessage(`{"summary":"old"}`)},
		{ID: "first", Type: "human.said", Time: now, Actor: event.Actor{Kind: event.ActorHuman, ID: "person"}, Payload: json.RawMessage(`{"text":"First instruction"}`)},
		{ID: "second", Type: "human.said", Time: now.Add(time.Second), Actor: event.Actor{Kind: event.ActorHuman, ID: "person"}, Payload: json.RawMessage(`{"text":"Second instruction"}`)},
		{ID: "progress-new", Type: task.Progressed, Scope: event.Scope{Task: "task"}, Payload: json.RawMessage(`{"summary":"latest"}`)},
	} {
		scheduler.Enqueue(fact)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	batch, err := scheduler.NextBatch(ctx)
	if err != nil || len(batch) != 3 {
		t.Fatalf("batch=%+v err=%v", batch, err)
	}
	inputs := (leader.Digest{}).Inputs(batch)
	if len(inputs) != 2 || inputs[0].Actor.Kind != event.ActorHuman {
		t.Fatalf("inputs=%+v", inputs)
	}
	text := inputs[0].Parts[0].Text
	for _, want := range []string{"first", "second", "First instruction", "Second instruction"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %s in %s", want, text)
		}
	}
	if strings.Contains(inputs[1].Parts[0].Text, "progress-old") || !strings.Contains(inputs[1].Parts[0].Text, "progress-new") {
		t.Fatalf("progress=%+v", inputs[1])
	}
}

func TestUrgentInputWakesAQuietLowPriorityBatch(t *testing.T) {
	scheduler := leader.NewScheduler()
	scheduler.Enqueue(event.Event{ID: "file", Type: "file.changed"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	batch := make(chan []event.Event, 1)
	go func() {
		facts, err := scheduler.NextBatch(ctx)
		if err == nil {
			batch <- facts
		}
	}()
	select {
	case facts := <-batch:
		t.Fatalf("low priority woke immediately: %+v", facts)
	case <-time.After(30 * time.Millisecond):
	}
	scheduler.Enqueue(event.Event{ID: "human", Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
	select {
	case facts := <-batch:
		if len(facts) != 2 || facts[0].ID != "human" {
			t.Fatalf("batch=%+v", facts)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestRoutedMessagesInformTheLeaderWithoutWakingIt(t *testing.T) {
	scheduler := leader.NewScheduler()
	scheduler.Inform(event.Event{ID: "routed", Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
	wait, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if batch, err := scheduler.NextBatch(wait); err == nil {
		t.Fatalf("routed message woke leader: %+v", batch)
	}
	scheduler.Enqueue(event.Event{ID: "report", Type: task.Reported})
	ctx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	batch, err := scheduler.NextBatch(ctx)
	if err != nil || len(batch) != 2 || batch[0].ID != "report" || batch[1].ID != "routed" {
		t.Fatalf("batch=%+v err=%v", batch, err)
	}
}

func TestSchedulerHandlesHumanInputBeforeAnAlreadyQueuedReport(t *testing.T) {
	scheduler := leader.NewScheduler()
	scheduler.Enqueue(event.Event{ID: "report", Type: task.Reported})
	scheduler.Enqueue(event.Event{ID: "human", Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, want := range []event.ID{"human", "report"} {
		fact, err := scheduler.Next(ctx)
		if err != nil || fact.ID != want {
			t.Fatalf("want=%s fact=%+v err=%v", want, fact, err)
		}
	}
}
