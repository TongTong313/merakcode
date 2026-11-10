package event_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestCredentialsAreRemovedBeforeEventsAreStoredOrDelivered(t *testing.T) {
	for _, kind := range []event.Type{"notice.sent", "message.completed", "tool.called", "tool.completed"} {
		t.Run(string(kind), func(t *testing.T) {
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			events, stop := bus.Subscribe(event.Filter{})
			defer stop()
			credential := "sk-abcdefghijklmnopqrstuvwxyz0123456789"
			body, _ := json.Marshal(map[string]any{"text": "Hello " + credential, "nested": []any{map[string]any{"text": credential, "env": []any{map[string]string{"name": "CUSTOM_KEY", "value": "array-private-value"}}}}, "password": "ordinary-private-value", "authorization": []string{"array-private-value"}, "env": map[string]string{"CUSTOM_KEY": "literal-private-value"}, "key": "thread-id", "count": uint64(9007199254740993)})
			fact, err := bus.Publish(t.Context(), event.Event{Stream: "session:one", Type: kind, Payload: body})
			if err != nil {
				t.Fatal(err)
			}
			saved, err := storage.Get(t.Context(), fact.ID)
			if err != nil {
				t.Fatal(err)
			}
			for _, got := range []event.Event{fact, saved, <-events} {
				if strings.Contains(string(got.Payload), credential) || strings.Contains(string(got.Payload), "private-value") {
					t.Fatal("event exposed a credential")
				}
				if !strings.Contains(string(got.Payload), "9007199254740993") || !strings.Contains(string(got.Payload), "thread-id") || !strings.Contains(string(got.Payload), "CUSTOM_KEY") || !json.Valid(got.Payload) {
					t.Fatal("redaction changed JSON data")
				}
			}
		})
	}
}

func TestImportedEventsAreRedactedWithoutChangingTheirIdentity(t *testing.T) {
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	fact := event.Event{ID: "remote-event", Stream: "remote:one", Seq: 1, Cause: "source", Type: "tool.progressed", Payload: json.RawMessage(`{"password":"ordinary-private-value","text":"sk-abcdefghijklmnopqrstuvwxyz0123456789"}`)}
	if err := bus.Import(t.Context(), fact); err != nil {
		t.Fatal(err)
	}
	saved, err := storage.Get(t.Context(), fact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != fact.ID || saved.Seq != fact.Seq || saved.Cause != fact.Cause {
		t.Fatal("import changed event identity")
	}
	if strings.Contains(string(saved.Payload), "ordinary-private-value") || strings.Contains(string(saved.Payload), "sk-") {
		t.Fatal("import stored a credential")
	}
}

func TestStreamingCredentialsAreRedactedAcrossMessageDeltas(t *testing.T) {
	for _, imported := range []bool{false, true} {
		bus := event.NewBus(memory.New(), time.Now, event.NewID)
		facts, stop := bus.Subscribe(event.Filter{})
		var delivered strings.Builder
		for i, text := range []string{"Hello sk-", "abcdefghijklmnopqrstuvwxyz0123456789 ", "password: ", "ordinary-private-value ", "finished "} {
			body, _ := json.Marshal(map[string]string{"kind": "text", "text": text})
			fact := event.Event{ID: event.ID(fmt.Sprint(i)), Stream: "session:streaming", Scope: event.Scope{Session: "streaming", Turn: "turn"}, Type: "message.delta", Payload: body}
			var err error
			if imported {
				err = bus.Import(t.Context(), fact)
			} else {
				_, err = bus.Publish(t.Context(), fact)
			}
			if err != nil {
				t.Fatal(err)
			}
			got := <-facts
			var delta struct{ Text string }
			if err := json.Unmarshal(got.Payload, &delta); err != nil {
				t.Fatal(err)
			}
			delivered.WriteString(delta.Text)
		}
		stop()
		if strings.Contains(delivered.String(), "sk-abcdefghijklmnopqrstuvwxyz0123456789") || strings.Contains(delivered.String(), "ordinary-private-value") {
			t.Fatal("stream reconstructed a credential")
		}
		if !strings.Contains(delivered.String(), "Hello") || !strings.Contains(delivered.String(), "finished") {
			t.Fatalf("safe streaming text was lost: %s", delivered.String())
		}
	}
}

func TestCompletedMessagesReleaseSafeStreamingTails(t *testing.T) {
	for _, chunks := range [][]string{{"Ye", "s", " sk"}, {"İİ s"}} {
		t.Run(strings.Join(chunks, ""), func(t *testing.T) {
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			facts, stop := bus.Subscribe(event.Filter{Types: []event.Type{"message.delta"}})
			for _, text := range chunks {
				body, _ := json.Marshal(map[string]string{"kind": "text", "text": text})
				if _, err := bus.Publish(t.Context(), event.Event{Stream: "session:tail", Scope: event.Scope{Session: "tail", Turn: "turn"}, Type: "message.delta", Payload: body}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := bus.Publish(t.Context(), event.Event{Stream: "session:tail", Scope: event.Scope{Session: "tail", Turn: "turn"}, Type: "message.completed", Payload: json.RawMessage(`{"role":"assistant","parts":[{"text":"Yes sk"}]}`)}); err != nil {
				t.Fatal(err)
			}
			stop()
			var text strings.Builder
			for fact := range facts {
				var delta struct{ Text string }
				_ = json.Unmarshal(fact.Payload, &delta)
				text.WriteString(delta.Text)
			}
			if text.String() != strings.Join(chunks, "") {
				t.Fatalf("safe output=%q", text.String())
			}
		})
	}
}
