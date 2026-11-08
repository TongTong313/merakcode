package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestSubscriberOnlySeesPersistedFacts(t *testing.T) {
	storage := memory.New()
	e, err := engine.New(engine.Deps{Store: storage})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	events, stop := e.Bus.Subscribe(event.Filter{})
	defer stop()
	ctx := context.Background()
	if _, err := e.Bus.Publish(ctx, event.Event{Stream: "session:a", Type: "message.sent", Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	seen := <-events
	saved, err := storage.Get(ctx, seen.ID)
	if err != nil || !reflect.DeepEqual(saved, seen) {
		t.Fatalf("persisted = %#v, %v; seen %#v", saved, err, seen)
	}
}

func TestEngineBudgetsRequestsAndRejectsAnInputThatCannotFit(t *testing.T) {
	for _, oversized := range []bool{false, true} {
		t.Run(fmt.Sprintf("oversized=%t", oversized), func(t *testing.T) {
			var replies []fake.Reply
			if !oversized {
				replies = []fake.Reply{{Text: "Done", Expect: func(request model.Request) error {
					if request.MaxTokens != 8192 {
						return fmt.Errorf("reply reservation=%d", request.MaxTokens)
					}
					return nil
				}}}
			}
			e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": fake.New(t, replies...)}, Workdir: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
			defer stop()
			input := "Hello"
			if oversized {
				input = strings.Repeat("large ", 100000)
			}
			if err := e.Send(ctx, id, []model.Part{{Text: input}}); err != nil {
				t.Fatal(err)
			}
			sawBudget := false
			for {
				select {
				case fact := <-facts:
					if fact.Type == "session.budget" {
						sawBudget = true
						if fact.Scope.Turn == "" {
							t.Fatal("request budget lost its turn scope")
						}
					}
					if fact.Type == "turn.finished" {
						var outcome struct{ Code string }
						json.Unmarshal(fact.Payload, &outcome)
						if !sawBudget || oversized && outcome.Code != "MRK-4002" || !oversized && outcome.Code != "" {
							t.Fatalf("budget=%v outcome=%s", sawBudget, fact.Payload)
						}
						return
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}

func TestLongRunningTurnWritesAnIncrementalSnapshot(t *testing.T) {
	storage := memory.New()
	var replies []fake.Reply
	for i := 0; i < 42; i++ {
		replies = append(replies, fake.Reply{Calls: []model.ToolCall{{ID: fmt.Sprintf("list-%d", i), Name: "list_dir", Input: json.RawMessage(`{"path":"."}`)}}})
	}
	waiting := make(chan struct{})
	hold := make(chan struct{})
	replies = append(replies, fake.Reply{Text: "Done", Hold: hold, Expect: func(model.Request) error { close(waiting); return nil }})
	e, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, replies...)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "Inspect"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-waiting:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	doc, err := storage.Fetch(ctx, "snapshot", string(id))
	if err != nil {
		t.Fatal(err)
	}
	var state session.State
	if err := json.Unmarshal(doc.Body, &state); err != nil {
		t.Fatal(err)
	}
	if state.LastSeq != 128 || len(state.Messages) == 0 {
		t.Fatalf("snapshot = %+v", state)
	}
}

func TestRestoredSessionRetainsLoadedDeferredTools(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	storage := memory.New()
	workdir := t.TempDir()
	start := func(replies ...fake.Reply) *engine.Engine {
		e, err := engine.New(engine.Deps{Store: storage, Workdir: workdir, Deferred: []tool.Tool{tool.ListDir{}}, Providers: map[string]model.Provider{"fake": fake.New(t, replies...)}})
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	first := start(fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: json.RawMessage(`{"names":["list_dir"]}`)}}}, fake.Reply{Text: "Loaded"})
	id, err := first.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	run := func(e *engine.Engine) {
		facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
		defer stop()
		if err := e.Send(ctx, id, []model.Part{{Text: "Continue"}}); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case fact := <-facts:
				if fact.Type == tool.Completed {
					result, _ := event.Decode[tool.Completion](fact)
					if result.IsError {
						t.Fatalf("tool failed: %+v", result)
					}
				}
				if fact.Type == "turn.finished" {
					return
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	run(first)
	first.Close()
	second := start(fake.Reply{Calls: []model.ToolCall{{ID: "call", Name: "call_tool", Input: json.RawMessage(`{"name":"list_dir","input":{"path":"."}}`)}}}, fake.Reply{Text: "Done"})
	defer second.Close()
	run(second)
}

func TestEngineResumesPersistedConversationAfterRestart(t *testing.T) {
	storage := memory.New()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := engine.New(engine.Deps{Store: storage, Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "First reply"})}})
	if err != nil {
		t.Fatal(err)
	}
	id, err := first.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	run := func(e *engine.Engine, text string) {
		events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
		defer stop()
		if err := e.Send(ctx, id, []model.Part{{Text: text}}); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case fact := <-events:
				if fact.Type == "turn.finished" {
					var outcome struct{ Stop string }
					json.Unmarshal(fact.Payload, &outcome)
					if outcome.Stop != "answered" {
						t.Fatalf("outcome = %s", fact.Payload)
					}
					return
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	run(first, "First")
	first.Close()
	second, err := engine.New(engine.Deps{Store: storage, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Second reply", Expect: func(request model.Request) error {
		if len(request.Messages) != 3 || request.Messages[1].Parts[0].Text != "First reply" {
			return fmt.Errorf("restored messages = %#v", request.Messages)
		}
		return nil
	}})}})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	run(second, "Second")
	facts, err := storage.Read(ctx, event.Stream("session:"+id), 1, 100)
	if err != nil || len(facts) != 11 || facts[0].Type != "session.created" || facts[10].Seq != 11 {
		t.Fatalf("fact count = %d, %v", len(facts), err)
	}
}
