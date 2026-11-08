package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestBufferedReplaysOfflineEventsAndRejectsReads(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	buffer := store.NewBuffered(nil, 2)
	facts := []event.Event{
		{ID: "a", Stream: "session:a", Seq: 1, Payload: json.RawMessage(`{"value":"original"}`)},
		{ID: "b", Stream: "session:a", Seq: 2, Payload: json.RawMessage(`{}`)},
	}
	if err := buffer.Append(ctx, facts); err != nil {
		t.Fatal(err)
	}
	facts[0].Payload[10] = 'X'
	if !buffer.Full() {
		t.Fatal("full queue must pause new turns")
	}
	if _, err := buffer.Read(ctx, "session:a", 1, 10); !errors.Is(err, store.ErrUnavailable) {
		t.Fatalf("offline read = %v", err)
	}
	if err := buffer.Reconnect(ctx, storage); err != nil {
		t.Fatal(err)
	}
	if buffer.Full() {
		t.Fatal("flushed queue still full")
	}
	got, err := buffer.Read(ctx, "session:a", 1, 10)
	if err != nil || len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" || string(got[0].Payload) != `{"value":"original"}` {
		t.Fatalf("replayed = %+v, %v", got, err)
	}
}

func TestBufferedReconnectHandlesLostAcknowledgementAndUnblocksAppend(t *testing.T) {
	ctx := context.Background()
	host := memory.New()
	fact := event.Event{ID: "ack-lost", Stream: "session:a", Seq: 1, Time: time.Now(), Payload: json.RawMessage(`{ "saved": true }`)}
	wire, _ := json.Marshal(fact)
	var durable event.Event
	if err := json.Unmarshal(wire, &durable); err != nil {
		t.Fatal(err)
	}
	if err := host.Append(ctx, []event.Event{durable}); err != nil {
		t.Fatal(err)
	}
	buffer := store.NewBuffered(nil, 1)
	if err := buffer.Append(ctx, []event.Event{fact}); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		finished <- buffer.Append(ctx, []event.Event{{ID: "next", Stream: "session:a", Seq: 2, Payload: json.RawMessage(`{}`)}})
	}()
	select {
	case err := <-finished:
		t.Fatalf("full queue discarded append: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	if err := buffer.Reconnect(ctx, host); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("append did not resume")
	}
	facts, err := host.Read(ctx, "session:a", 1, 10)
	if err != nil || len(facts) != 2 || facts[1].ID != "next" {
		t.Fatalf("durable events = %+v, %v", facts, err)
	}
}
