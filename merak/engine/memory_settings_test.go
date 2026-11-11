package engine_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/store"
	storage "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

func TestMemoryManagementMethodsListReadAndDeleteTheNotesOfAProject(t *testing.T) {
	ctx := context.Background()
	dir, durable := t.TempDir(), storage.New()
	e, err := engine.New(engine.Deps{Store: durable, Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	owner := memory.ProjectOwner(dir)
	repo := memory.New(durable)
	note, err := repo.Remember(ctx, memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "Use tabs"})
	if err != nil {
		t.Fatal(err)
	}
	other := memory.ProjectOwner(t.TempDir())
	if _, err := repo.Remember(ctx, memory.Note{Scope: other.Scope, Owner: other.ID, Kind: "fact", Text: "Not ours"}); err != nil {
		t.Fatal(err)
	}
	listed, err := e.MemoryList(ctx, dir+"/", "")
	if err != nil || len(listed) != 1 || listed[0].ID != note.ID {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	if listed, err = e.MemoryList(ctx, dir, "group"); err != nil || len(listed) != 0 {
		t.Fatalf("another scope: %+v err=%v", listed, err)
	}
	if got, err := e.MemoryRead(ctx, note.ID); err != nil || got.Text != "Use tabs" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if err := e.MemoryDelete(ctx, note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.MemoryRead(ctx, note.ID); err == nil {
		t.Fatal("a deleted note can still be read")
	}
}

func TestSwitchingExtractionAndRecallOffStopsThemAndOnBringsThemBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir, durable := t.TempDir(), storage.New()
	owner := memory.ProjectOwner(dir)
	if _, err := memory.New(durable).Remember(ctx, memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: "pitfall", Text: "Run Go checks inside merak."}); err != nil {
		t.Fatal(err)
	}
	var recalled []bool
	answer := func(req model.Request) error {
		var text strings.Builder
		for _, message := range req.Messages {
			for _, part := range message.Parts {
				text.WriteString(part.Text)
			}
		}
		recalled = append(recalled, strings.Contains(text.String(), "Run Go checks inside merak."))
		return nil
	}
	extractions := 0
	provider := fake.New(t,
		fake.Reply{Text: "Answer one.", Expect: answer},
		fake.Reply{Text: "Answer two.", Expect: answer},
		fake.Reply{Text: `[{"kind":"fact","text":"The build uses pnpm","tags":[]}]`, Expect: func(model.Request) error { extractions++; return nil }},
	)
	e, err := engine.New(engine.Deps{Store: durable, Workdir: dir, MemoryIdle: 50 * time.Millisecond, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()

	e.ConfigureMemory(engine.MemorySettings{AutoExtract: false, AutoRecall: false})
	first, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{"turn.finished"}})
	defer stop()
	if err := e.Send(ctx, first, []model.Part{{Text: "Hello"}}); err != nil {
		t.Fatal(err)
	}
	<-turns
	time.Sleep(300 * time.Millisecond) // long enough for an idle extraction, which would exhaust the script's wrong reply
	if len(recalled) != 1 || recalled[0] {
		t.Fatalf("recall happened while it was off: %v", recalled)
	}
	if notes, _ := memory.New(durable).List(ctx, []memory.Owner{owner}); len(notes) != 1 {
		t.Fatalf("a note was saved while extraction was off: %d", len(notes))
	}

	e.ConfigureMemory(engine.MemorySettings{AutoExtract: true, AutoRecall: true})
	second, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Send(ctx, second, []model.Part{{Text: "Hello again"}}); err != nil {
		t.Fatal(err)
	}
	<-turns
	deadline := time.Now().Add(5 * time.Second)
	for {
		notes, _ := memory.New(durable).List(ctx, []memory.Owner{owner})
		if len(notes) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("extraction never saved a note (extractions=%d)", extractions)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(recalled) != 2 || !recalled[1] {
		t.Fatalf("recall did not come back: %v", recalled)
	}
	_ = store.ErrNotFound
}
