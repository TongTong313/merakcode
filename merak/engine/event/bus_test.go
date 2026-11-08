package event_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func TestPublishDeliversConsecutiveEventsPerStream(t *testing.T) {
	now := time.Date(2026, 11, 7, 9, 30, 0, 0, time.UTC)
	var next int
	bus := event.NewBus(nil, func() time.Time { return now }, func() event.ID {
		next++
		return event.ID(fmt.Sprintf("event-%d", next))
	})
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	for _, want := range []struct {
		stream event.Stream
		seq    uint64
		id     event.ID
	}{
		{"session:a", 1, "event-1"},
		{"session:a", 2, "event-2"},
		{"session:b", 1, "event-3"},
	} {
		published, err := bus.Publish(context.Background(), event.Event{
			Stream: want.stream,
			Type:   "message.sent",
		})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case got := <-events:
			if got.ID != want.id || got.Seq != want.seq || got.Stream != want.stream || !got.Time.Equal(now) || got.Type != "message.sent" {
				t.Fatalf("received %+v, want id=%s stream=%s seq=%d time=%s", got, want.id, want.stream, want.seq, now)
			}
			if published.ID != got.ID || published.Seq != got.Seq {
				t.Fatalf("Publish returned %+v, delivered %+v", published, got)
			}
		case <-time.After(time.Second):
			t.Fatal("subscriber did not receive the event")
		}
	}
	unsubscribe()
	if _, ok := <-events; ok {
		t.Fatal("unsubscribed channel is still open")
	}
}

func TestSlowSubscriberGetsOneLaggedNoticeWithoutBlockingOthers(t *testing.T) {
	bus := event.NewBus(nil, time.Now, event.NewID)
	slow, stopSlow := bus.Subscribe(event.Filter{Scope: event.Scope{Session: "a"}})
	defer stopSlow()
	fast, stopFast := bus.Subscribe(event.Filter{})
	defer stopFast()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for i := 0; i < 1100; i++ {
		if _, err := bus.Publish(ctx, event.Event{Stream: "session:a", Scope: event.Scope{Session: "a"}, Type: "message.sent"}); err != nil {
			t.Fatal(err)
		}
		select {
		case fact := <-fast:
			if fact.Seq != uint64(i+1) {
				t.Fatalf("seq=%d", fact.Seq)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	notices := 0
	for fact := range slow {
		if fact.Type == event.Lagged {
			notices++
		}
	}
	if notices != 1 {
		t.Fatalf("lagged notices=%d", notices)
	}
	filtered, stop := bus.Subscribe(event.Filter{Streams: []event.Stream{"session:a"}, Types: []event.Type{"message.completed"}, Scope: event.Scope{Session: "a"}})
	for _, kind := range []event.Type{"message.sent", "message.completed"} {
		if _, err := bus.Publish(ctx, event.Event{Stream: "session:a", Scope: event.Scope{Session: "a"}, Type: kind}); err != nil {
			t.Fatal(err)
		}
	}
	stop()
	count := 0
	for fact := range filtered {
		if fact.Type != "message.completed" {
			t.Fatalf("unexpected event=%+v", fact)
		}
		count++
	}
	if count != 1 {
		t.Fatalf("matched=%d", count)
	}
}
