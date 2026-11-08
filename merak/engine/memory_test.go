package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestNewConversationRecallsProjectNotesInTheFirstUserMessage(t *testing.T) {
	dir := t.TempDir()
	durable := storage.New()
	repo := memory.New(durable)
	owner := memory.ProjectOwner(dir)
	_, err := repo.Remember(context.Background(), memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: "pitfall", Text: "Run Go checks inside merak.", Tags: []string{"checks"}})
	if err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t, fake.Reply{Text: "Ready", Expect: func(req model.Request) error {
		if strings.Contains(req.System, "Run Go checks") {
			return fmt.Errorf("memory entered frozen system prompt")
		}
		var text string
		for _, part := range req.Messages[0].Parts {
			text += part.Text
		}
		if !strings.Contains(text, "Run Go checks inside merak.") || !strings.Contains(text, "Begin") {
			return fmt.Errorf("first user message lacks memory or input")
		}
		return nil
	}})
	e, err := engine.New(engine.Deps{Store: durable, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	if _, err := e.Chat(context.Background(), "fake", "Begin"); err != nil {
		t.Fatal(err)
	}
}

func TestIdleConversationExtractsSafeNotesForTheNextConversation(t *testing.T) {
	dir := t.TempDir()
	durable := storage.New()
	provider := fake.New(t,
		fake.Reply{Text: "The compiler needs the module directory."},
		fake.Reply{Text: `[{"kind":"pitfall","text":"Compile inside the module directory.","tags":["compiler"]},{"kind":"fact","text":"password=example-secret","tags":[]}]`, Usage: &model.Usage{Input: 100, Output: 20}},
	)
	e, err := engine.New(engine.Deps{Store: durable, Workdir: dir, Providers: map[string]model.Provider{"fake": provider}, MemoryIdle: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	events, unsubscribe := e.Bus.Subscribe(event.Filter{Types: []event.Type{memory.Extracted}})
	defer unsubscribe()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "How do I run the compiler?"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-events:
		result, err := event.Decode[memory.Extraction](fact)
		if err != nil || result.Stored != 1 || result.Usage.Input != 100 || result.Usage.Output != 20 {
			t.Fatalf("extraction=%+v error=%v", result, err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	notes, err := memory.New(durable).Recall(ctx, memory.Query{Owners: []memory.Owner{memory.ProjectOwner(dir)}})
	if err != nil || len(notes) != 1 || notes[0].Text != "Compile inside the module directory." || notes[0].Source != id {
		t.Fatalf("notes=%+v error=%v", notes, err)
	}
}

func TestNewTurnCancelsIdleExtractionBeforeRequestingItsAnswer(t *testing.T) {
	started := make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Text: "First answer"},
		fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error { close(started); return nil }},
		fake.Reply{Text: "Second answer"},
		fake.Reply{Text: `[]`},
	)
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": provider}, Workdir: t.TempDir(), MemoryIdle: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, id, []model.Part{{Text: "First"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	events, unsubscribe := e.Bus.Subscribe(event.Filter{Types: []event.Type{"message.completed"}})
	defer unsubscribe()
	if err := e.Send(ctx, id, []model.Part{{Text: "Second"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-events:
		message, err := event.Decode[model.Message](fact)
		if err != nil || message.Parts[0].Text != "Second answer" {
			t.Fatalf("message=%+v error=%v", message, err)
		}
	case <-ctx.Done():
		t.Fatal("new turn waited for idle extraction")
	}
}
