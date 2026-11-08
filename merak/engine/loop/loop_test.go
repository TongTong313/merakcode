package loop_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestMalformedToolArgumentsReturnAToolError(t *testing.T) {
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "invalid-call", Name: "read_file", Input: []byte(`{"path":`)}}},
		fake.Reply{Text: "The arguments need fixing.", Expect: func(req model.Request) error {
			if len(req.Messages) != 3 || len(req.Messages[2].Parts) != 1 {
				return fmt.Errorf("missing tool error: %+v", req.Messages)
			}
			result := req.Messages[2].Parts[0].ToolResult
			if result == nil || !result.IsError || result.CallID != "invalid-call" {
				return fmt.Errorf("invalid arguments were not rejected: %+v", result)
			}
			return nil
		}},
	)
	runner := loop.Loop{Model: provider, Bus: event.NewBus(nil, time.Now, event.NewID), Tools: tool.NewPool("test", tool.ReadFile{})}
	state := session.State{ID: "invalid-chat"}
	outcome, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Read a file"}}})
	if err != nil || len(outcome.Final) != 1 || outcome.Final[0].Text != "The arguments need fixing." {
		t.Fatalf("outcome=%+v error=%v", outcome, err)
	}
}

type eventJournal struct{ path string }

func (j eventJournal) Append(ctx context.Context, events []event.Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	file, err := os.OpenFile(j.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	for _, e := range events {
		if err := json.NewEncoder(file).Encode(e); err != nil {
			return err
		}
	}
	return file.Sync()
}

func (j eventJournal) Read() ([]event.Event, error) {
	file, err := os.Open(j.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	var events []event.Event
	for {
		var e event.Event
		if err := decoder.Decode(&e); err == io.EOF {
			return events, nil
		} else if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
}

func TestStreamingKeepsOnlyConsecutiveFactsInTheSink(t *testing.T) {
	journal := eventJournal{path: filepath.Join(t.TempDir(), "events.ndjson")}
	bus := event.NewBus(journal, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	runner := loop.Loop{Bus: bus, Model: fake.New(t, fake.Reply{Text: "Hello"})}
	state := session.State{ID: "stored-chat"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Hi"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var transient int
	for e := range events {
		if e.Type == "message.delta" {
			transient++
		}
	}
	stored, err := journal.Read()
	if err != nil {
		t.Fatal(err)
	}
	if transient == 0 || len(stored) != 4 {
		t.Fatalf("transient=%d stored=%+v", transient, stored)
	}
	want := []event.Type{"turn.started", "message.sent", "message.completed", "turn.finished"}
	for index, e := range stored {
		if e.Type != want[index] || e.Seq != uint64(index+1) {
			t.Fatalf("stored event %d = %+v", index, e)
		}
	}
}

func TestDeltaEventsReconstructTheCompletedMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello \"}}]}\n\n"+
			"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	runner := loop.Loop{Bus: bus, Model: openai.New(openai.Options{BaseURL: server.URL})}
	state := session.State{ID: "stream-chat"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Hello"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var deltas []string
	var completed model.Message
	var sequences []uint64
	for e := range events {
		if e.Type == "message.delta" {
			chunk, err := event.Decode[model.Chunk](e)
			if err != nil {
				t.Fatal(err)
			}
			if e.Seq != 0 || e.ID == "" || e.Time.IsZero() {
				t.Fatalf("invalid transient envelope: %+v", e)
			}
			if chunk.Kind == model.Text {
				deltas = append(deltas, chunk.Text)
			}
			continue
		}
		sequences = append(sequences, e.Seq)
		if e.Type == "message.completed" {
			var err error
			completed, err = event.Decode[model.Message](e)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if !reflect.DeepEqual(deltas, []string{"Hello ", "world"}) || len(completed.Parts) != 1 || completed.Parts[0].Text != "Hello world" {
		t.Fatalf("deltas=%v completed=%+v", deltas, completed)
	}
	if !reflect.DeepEqual(sequences, []uint64{1, 2, 3, 4}) || state.LastSeq != 4 {
		t.Fatalf("stored sequences=%v lastSeq=%d", sequences, state.LastSeq)
	}
}

func TestReplayReconstructsTheLiveToolConversation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Project notes"), 0o600); err != nil {
		t.Fatal(err)
	}
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	runner := loop.Loop{
		Bus: bus, Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: dir},
		Model: fake.New(t,
			fake.Reply{Calls: []model.ToolCall{
				{ID: "read-a", Name: "read_file", Input: json.RawMessage(`{"path":"README.md"}`)},
				{ID: "read-b", Name: "read_file", Input: json.RawMessage(`{"path":"missing.txt"}`)},
			}},
			fake.Reply{Text: "One file was available."},
		),
	}
	live := session.State{ID: "replay-chat"}
	if _, err := runner.RunTurn(context.Background(), &live, loop.Input{Parts: []model.Part{{Text: "Read the files"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var replay session.State
	for e := range events {
		data, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		var restored event.Event
		if err := json.Unmarshal(data, &restored); err != nil {
			t.Fatal(err)
		}
		if err := session.Fold(&replay, restored); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(replay, live) {
		t.Fatalf("replay = %+v, live = %+v", replay, live)
	}
	if len(replay.Messages) != 4 || replay.Messages[2].Role != model.Tool || len(replay.Messages[2].Parts) != 2 {
		t.Fatalf("tool results were not grouped into one message: %+v", replay.Messages)
	}
}

func TestToolEventsPairEachResultWithItsCall(t *testing.T) {
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	runner := loop.Loop{
		Bus: bus, Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: t.TempDir()},
		Model: fake.New(t,
			fake.Reply{Calls: []model.ToolCall{
				{ID: "read-a", Name: "read_file", Input: json.RawMessage(`{"path":"a.txt"}`)},
				{ID: "read-b", Name: "read_file", Input: json.RawMessage(`{"path":"b.txt"}`)},
			}},
			fake.Reply{Text: "The files do not exist."},
		),
	}
	state := session.State{ID: "pair-chat"}
	if _, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Read both files"}}}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var types []event.Type
	called := map[string]event.ID{}
	var completed []string
	for e := range events {
		if e.Type == "message.delta" {
			continue
		}
		types = append(types, e.Type)
		if e.Type == "tool.called" {
			call, err := event.Decode[model.ToolCall](e)
			if err != nil {
				t.Fatal(err)
			}
			called[call.ID] = e.ID
		}
		if e.Type == "tool.completed" {
			result, err := event.Decode[tool.Completion](e)
			if err != nil {
				t.Fatal(err)
			}
			if e.Cause == "" || e.Cause != called[result.CallID] || !result.IsError {
				t.Fatalf("result is not paired with its failed call: %+v, result=%+v", e, result)
			}
			completed = append(completed, result.CallID)
		}
	}
	want := []event.Type{"turn.started", "message.sent", "message.completed", "tool.called", "tool.called", "tool.completed", "tool.completed", "message.completed", "turn.finished"}
	if !reflect.DeepEqual(types, want) || !reflect.DeepEqual(completed, []string{"read-a", "read-b"}) {
		t.Fatalf("event types = %v, completed = %v", types, completed)
	}
}

func TestTurnFeedsReadFileResultBackToTheModel(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("A local coding tool."), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "read-1", Name: "read_file", Input: json.RawMessage(`{"path":"README.md"}`)}}},
		fake.Reply{Text: "This project is a local coding tool.", Expect: func(req model.Request) error {
			if len(req.Tools) != 1 || req.Tools[0].Name != "read_file" {
				return fmt.Errorf("model did not receive read_file: %+v", req.Tools)
			}
			if len(req.Messages) != 3 || req.Messages[2].Role != model.Tool {
				return fmt.Errorf("expected user, assistant, and tool messages, got %+v", req.Messages)
			}
			parts := req.Messages[2].Parts
			if len(parts) != 1 || parts[0].ToolResult == nil {
				return fmt.Errorf("expected one tool result, got %+v", parts)
			}
			result := parts[0].ToolResult
			if result.CallID != "read-1" || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "A local coding tool." {
				return fmt.Errorf("incorrect tool result: %+v", result)
			}
			return nil
		}},
	)
	runner := loop.Loop{
		Model: provider, Bus: event.NewBus(nil, time.Now, event.NewID),
		Tools: tool.NewPool("test", tool.ReadFile{}), Env: tool.Env{Workdir: dir},
	}
	state := session.State{ID: "read-chat"}
	outcome, err := runner.RunTurn(context.Background(), &state, loop.Input{Parts: []model.Part{{Text: "Summarize README.md"}}})
	if err != nil || outcome.Stop != loop.Answered || len(outcome.Final) != 1 || outcome.Final[0].Text != "This project is a local coding tool." {
		t.Fatalf("outcome = %+v, error = %v", outcome, err)
	}
}

func TestTurnAnswersAndPublishesItsConversation(t *testing.T) {
	var next int
	bus := event.NewBus(nil, time.Now, func() event.ID {
		next++
		return event.ID(fmt.Sprintf("event-%d", next))
	})
	events, unsubscribe := bus.Subscribe(event.Filter{})
	state := session.State{ID: "chat-a", System: "You are a coding assistant."}
	provider := fake.New(t, fake.Reply{Text: "Welcome", Expect: func(req model.Request) error {
		want := []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}
		if req.System != state.System || !reflect.DeepEqual(req.Messages, want) {
			return fmt.Errorf("model request = %+v, want the system prompt and user input", req)
		}
		return nil
	}})
	runner := loop.Loop{Model: provider, Bus: bus}
	result, err := runner.RunTurn(context.Background(), &state, loop.Input{
		Parts: []model.Part{{Text: "Hello"}}, Actor: event.Actor{Kind: event.ActorHuman},
	})
	if err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var types []event.Type
	for e := range events {
		if e.Type == "message.delta" {
			continue
		}
		types = append(types, e.Type)
		if e.Stream != "session:chat-a" || e.Scope.Session != "chat-a" {
			t.Fatalf("event belongs to the wrong conversation: %+v", e)
		}
	}
	wantTypes := []event.Type{"turn.started", "message.sent", "message.completed", "turn.finished"}
	if !reflect.DeepEqual(types, wantTypes) {
		t.Fatalf("events = %v, want %v", types, wantTypes)
	}
	if result.Stop != loop.Answered || !reflect.DeepEqual(result.Final, []model.Part{{Text: "Welcome"}}) {
		t.Fatalf("outcome = %+v, want answered with Welcome", result)
	}
	wantMessages := []model.Message{
		{Role: model.User, Parts: []model.Part{{Text: "Hello"}}},
		{Role: model.Assistant, Parts: []model.Part{{Text: "Welcome"}}},
	}
	if !reflect.DeepEqual(state.Messages, wantMessages) || state.LastSeq != 4 {
		t.Fatalf("state = %+v, want the conversation and lastSeq=4", state)
	}
}
