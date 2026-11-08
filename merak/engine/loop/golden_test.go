package loop_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestSessionGoldenMatchesRealConversation(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("A note from the workspace."), 0600); err != nil {
		t.Fatal(err)
	}
	storage := memory.New()
	index := 0
	bus := event.NewBus(storage, func() time.Time { return time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC) }, func() event.ID { index++; return event.ID(fmt.Sprintf("golden-%02d", index)) })
	live, stop := bus.Subscribe(event.Filter{})
	defer stop()
	pool := tool.NewPool("golden", tool.ReadFile{})
	manager := session.NewManager(storage, bus)
	state, err := manager.Create(ctx, session.State{ID: "golden", Config: session.Config{Provider: "fake", Model: "golden", Workdir: "/workspace"}, System: "Read workspace notes.", Tools: pool.Specs()})
	if err != nil {
		t.Fatal(err)
	}
	usage := &model.Usage{Input: 20, Output: 5, CacheRead: 4, CostKnown: true, Cost: 0.01, Currency: "USD"}
	runner := loop.Loop{Bus: bus, Tools: pool, Env: tool.Env{Workdir: dir, Reads: new(tool.Reads)}, Model: fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "read-note", Name: "read_file", Input: json.RawMessage(`{"path":"note.txt"}`)}}, Usage: usage},
		fake.Reply{Text: "The note is ready.", Usage: usage})}
	if _, err := runner.RunTurn(ctx, state, loop.Input{Parts: []model.Part{{Text: "Read note.txt"}}, Actor: event.Actor{Kind: event.ActorHuman}}); err != nil {
		t.Fatal(err)
	}
	stop()
	var events []event.Event
	for fact := range live {
		events = append(events, fact)
	}
	fixture := struct {
		Events []event.Event  `json:"events"`
		State  *session.State `json:"state"`
	}{events, state}
	data, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join("..", "..", "..", "schema", "testdata", "session.json")
	if os.Getenv("MERAK_GENERATE_SESSION_GOLDEN") == "1" {
		if err := os.WriteFile(file, append(data, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var actual, expected any
	if err := json.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatal("session golden differs; regenerate only after reviewing the behavior change")
	}
}
