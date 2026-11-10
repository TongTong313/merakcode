package event_test

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"reflect"
	"testing"
	"time"
)

func TestImportPreservesTheHostsIdentityAndRequiresConsecutiveFacts(t *testing.T) {
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	events, stop := bus.Subscribe(event.Filter{})
	defer stop()
	fact := event.Event{ID: "host-event", Stream: "group:cloud", Seq: 1, Time: time.Now().UTC(), Type: "group.message", Scope: event.Scope{Group: "cloud"}, Payload: json.RawMessage(`{"text":"hello"}`)}
	if err := bus.Import(t.Context(), fact); err != nil {
		t.Fatal(err)
	}
	if got := <-events; !reflect.DeepEqual(got, fact) {
		t.Fatalf("event=%+v", got)
	}
	stored, err := storage.Get(t.Context(), fact.ID)
	if err != nil || !reflect.DeepEqual(stored, fact) {
		t.Fatalf("stored=%+v %v", stored, err)
	}
	gap := fact
	gap.ID = "gap"
	gap.Seq = 3
	if err := bus.Import(t.Context(), gap); err == nil {
		t.Fatal("accepted a gap")
	}
	select {
	case unexpected := <-events:
		t.Fatalf("delivered invalid event=%+v", unexpected)
	default:
	}
}
