package session_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
)

func TestAnOlderSnapshotCannotReplaceANewerCheckpoint(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := session.NewManager(storage, bus)
	state, err := manager.Create(ctx, session.State{ID: "checkpoint", Title: "Before"})
	if err != nil {
		t.Fatal(err)
	}
	before := *state
	fact, err := bus.Publish(ctx, event.Event{Stream: "session:checkpoint", Scope: event.Scope{Session: "checkpoint"}, Type: session.Updated, Payload: json.RawMessage(`{"title":"After"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Fold(state, fact); err != nil {
		t.Fatal(err)
	}
	if err := manager.Snapshot(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := manager.Snapshot(ctx, &before); err != nil {
		t.Fatal(err)
	}
	doc, err := storage.Fetch(ctx, "snapshot", "checkpoint")
	if err != nil {
		t.Fatal(err)
	}
	var saved session.State
	if err := json.Unmarshal(doc.Body, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.LastSeq != fact.Seq || saved.Title != "After" {
		t.Fatalf("checkpoint regressed: seq=%d title=%q", saved.LastSeq, saved.Title)
	}
}

func TestConcurrentSessionUpdatesKeepTheirSequenceAndCheckpoint(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	manager := session.NewManager(storage, bus)
	state, err := manager.Create(ctx, session.State{ID: "concurrent"})
	if err != nil {
		t.Fatal(err)
	}
	var writers sync.WaitGroup
	start := make(chan struct{})
	for writer := range 4 {
		writers.Go(func() {
			<-start
			for step := range 32 {
				value := fmt.Sprintf("%d/%d", writer, step)
				body, _ := json.Marshal(session.Change{Title: &value})
				_, err := state.Publish(ctx, bus, event.Event{Stream: "session:concurrent", Scope: event.Scope{Session: "concurrent"}, Type: session.Updated, Payload: body})
				if err != nil {
					t.Error(err)
					return
				}
				view := state.Read()
				if view.LastSeq < 2 || view.Title == "" {
					t.Error("published update is missing from the readable state")
					return
				}
				if err := manager.Snapshot(ctx, view); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	close(start)
	writers.Wait()
	facts, err := manager.Export(ctx, "concurrent")
	if err != nil {
		t.Fatal(err)
	}
	last := facts[len(facts)-1]
	change, err := event.Decode[session.Change](last)
	if err != nil {
		t.Fatal(err)
	}
	view := state.Read()
	if view.LastSeq != 129 || view.LastSeq != last.Seq || change.Title == nil || view.Title != *change.Title {
		t.Fatalf("live state does not match the last event: seq=%d last=%d", view.LastSeq, last.Seq)
	}
	restarted := session.NewManager(storage, event.NewBus(storage, time.Now, event.NewID))
	loaded, err := restarted.Load(ctx, "concurrent")
	if err != nil {
		t.Fatal(err)
	}
	if restored := loaded.Read(); restored.LastSeq != view.LastSeq || restored.Title != view.Title {
		t.Fatal("restart changed the final update")
	}
}

func TestReadableStateDoesNotShareMessagesOrToolArguments(t *testing.T) {
	state := session.State{
		Config: session.Config{Switches: map[string]bool{"shell": true}},
		Messages: []model.Message{{Role: model.Assistant, Parts: []model.Part{
			{ToolCall: &model.ToolCall{ID: "call", Name: "shell", Input: json.RawMessage(`{"unfinished"`)}},
			{ToolResult: &model.ToolResult{CallID: "call", Parts: []model.Part{{Image: &model.Image{Data: []byte{1, 2}}}}}},
		}}},
	}
	view := state.Read()
	if string(view.Messages[0].Parts[0].ToolCall.Input) != `{"unfinished"` {
		t.Fatal("reading the state changed malformed tool arguments")
	}
	view.Config.Switches["shell"] = false
	view.Messages[0].Parts[0].ToolCall.Input[0] = '['
	view.Messages[0].Parts[1].ToolResult.Parts[0].Image.Data[0] = 9
	if !state.Config.Switches["shell"] || state.Messages[0].Parts[0].ToolCall.Input[0] != '{' || state.Messages[0].Parts[1].ToolResult.Parts[0].Image.Data[0] != 1 {
		t.Fatal("editing a readable copy changed the source state")
	}
}
