package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestFullStorageBufferRejectsNewTurnsAndReportsStorageState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	disk := memory.New()
	buffer := store.NewBuffered(disk, 1)
	e, err := engine.New(engine.Deps{Store: buffer, Providers: map[string]model.Provider{"fake": fake.New(t)}, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{"engine.storage"}})
	defer stop()
	buffer.Disconnect()
	select {
	case fact := <-facts:
		var state struct {
			Connected bool `json:"connected"`
		}
		if json.Unmarshal(fact.Payload, &state) != nil || state.Connected {
			t.Fatalf("state=%s", fact.Payload)
		}
	case <-ctx.Done():
		t.Fatal("storage state was not announced")
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Wait for storage"}}); !errors.Is(err, store.ErrUnavailable) {
		t.Fatalf("new turn=%v", err)
	}
	if err := e.ReconnectStorage(ctx, disk); err != nil {
		t.Fatal(err)
	}
}
