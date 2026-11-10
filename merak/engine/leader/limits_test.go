package leader_test

import (
	"context"
	"fmt"
	"testing"
	"testing/synctest"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
)

func TestTurnLimitRetainsArrivalsAndWakesWithoutAnotherEvent(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		scheduler := leader.NewScheduler()
		limiter := leader.NewTurnLimiter(time.Now, scheduler.Signal)
		scheduler.SetAdmission(func(context.Context) (time.Time, error) { return limiter.Take("thread", 1, 30), nil })
		scheduler.Enqueue(event.Event{ID: "first", Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
		if batch, err := scheduler.NextBatch(t.Context()); err != nil || len(batch) != 1 {
			t.Fatalf("first=%v %v", batch, err)
		}
		scheduler.Enqueue(event.Event{ID: "second", Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
		delivered := make(chan []event.Event, 1)
		go func() {
			batch, err := scheduler.NextBatch(t.Context())
			if err == nil {
				delivered <- batch
			}
		}()
		synctest.Wait()
		time.Sleep(10 * time.Second)
		for i := range 35 {
			scheduler.Enqueue(event.Event{ID: event.ID(fmt.Sprint("pending-", i)), Type: "human.said", Actor: event.Actor{Kind: event.ActorHuman}})
		}
		synctest.Wait()
		select {
		case <-delivered:
			t.Fatal("thread exceeded its limit")
		default:
		}
		time.Sleep(50 * time.Second)
		synctest.Wait()
		batch := <-delivered
		if len(batch) != 30 || batch[0].ID != "second" {
			t.Fatalf("batch=%v", batch)
		}
		go func() {
			batch, err := scheduler.NextBatch(t.Context())
			if err == nil {
				delivered <- batch
			}
		}()
		time.Sleep(time.Minute)
		synctest.Wait()
		remaining := <-delivered
		if len(remaining) != 6 {
			t.Fatalf("remaining=%v", remaining)
		}
		seen := map[event.ID]bool{}
		for _, fact := range append(batch, remaining...) {
			if seen[fact.ID] {
				t.Fatal("event duplicated")
			}
			seen[fact.ID] = true
		}
		if len(seen) != 36 {
			t.Fatalf("events=%d", len(seen))
		}
	})
}

func TestGroupTurnLimitSharesSlotsAndHonorsUpdatedSettings(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := leader.NewTurnLimiter(func() time.Time { return now }, nil)
	if !limiter.Take("first", 6, 1).IsZero() {
		t.Fatal("first slot denied")
	}
	if retry := limiter.Take("second", 6, 1); retry != now.Add(time.Minute) {
		t.Fatalf("retry=%v", retry)
	}
	if !limiter.Take("second", 6, 2).IsZero() {
		t.Fatal("updated group limit was not applied")
	}
	if limiter.Take("second", 1, 30).IsZero() {
		t.Fatal("updated thread limit was ignored")
	}
	now = now.Add(time.Minute)
	if !limiter.Take("second", 1, 30).IsZero() {
		t.Fatal("expired slots were retained")
	}
}
