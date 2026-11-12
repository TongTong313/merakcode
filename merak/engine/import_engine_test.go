package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// legacyFacts builds the events of a conversation of an earlier version the way the migration does: a Created event
// without a system prompt, then one user message, with the original times.
func legacyFacts(t *testing.T, id event.ID, workdir string, at time.Time) []event.Event {
	t.Helper()
	created, err := json.Marshal(session.State{ID: id, Title: "Old chat", Config: session.Config{Provider: "fake", Model: "m", Workdir: workdir}})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := json.Marshal(session.Completion{Message: model.Message{Role: model.User, Parts: []model.Part{{Text: "hello from the past"}}}})
	if err != nil {
		t.Fatal(err)
	}
	stream, scope := event.Stream("session:"+id), event.Scope{Session: id}
	return []event.Event{
		{ID: "legacy-1", Stream: stream, Seq: 1, Time: at, Type: session.Created, Scope: scope, Actor: event.Actor{Kind: event.ActorHuman}, Payload: created},
		{ID: "legacy-2", Stream: stream, Seq: 2, Time: at.Add(time.Minute), Type: session.MessageSent, Scope: scope, Actor: event.Actor{Kind: event.ActorHuman}, Payload: sent},
	}
}

func TestAnImportedConversationKeepsItsTimesAndGetsASystemPromptForItsFolder(t *testing.T) {
	ctx := t.Context()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	folder := t.TempDir()
	at := time.Date(2025, 3, 4, 5, 6, 7, 0, time.UTC)
	id, err := e.ImportConversation(ctx, legacyFacts(t, "ses_old", folder, at))
	if err != nil {
		t.Fatal(err)
	}
	state, err := e.SessionSnapshot(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if state.ID == "ses_old" || len(state.Messages) != 1 || state.Title != "Old chat" {
		t.Fatalf("state = %+v", state)
	}
	if !strings.Contains(state.System, folder) {
		t.Fatalf("the system prompt does not name the folder of the conversation: %q", state.System)
	}
	infos, err := e.ListSessions(ctx)
	if err != nil || len(infos) != 1 || !infos[0].CreatedAt.Equal(at) {
		t.Fatalf("infos = %+v (%v), want the original creation time", infos, err)
	}
	missing := t.TempDir() + "/gone"
	other, err := e.ImportConversation(ctx, legacyFacts(t, "ses_gone", missing, at))
	if err != nil {
		t.Fatalf("a conversation whose folder is gone must still import: %v", err)
	}
	if state, err = e.SessionSnapshot(ctx, other); err != nil || state.System == "" {
		t.Fatalf("state = %+v (%v)", state, err)
	}
}

func TestEngineWritesThatTheMigrationNeedsAreOpenToTheHost(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()

	t.Run("a plan keeps its ended status", func(t *testing.T) {
		id, err := e.ImportConversation(ctx, legacyFacts(t, "ses_plan", t.TempDir(), time.Now()))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.ImportPlan(ctx, id, "# Plan\n1. Go", plan.Done); err != nil {
			t.Fatal(err)
		}
		got, err := e.GetPlan(ctx, id)
		if err != nil || got.Status != plan.Done || got.Content != "# Plan\n1. Go" {
			t.Fatalf("plan = %+v (%v)", got, err)
		}
	})
	t.Run("a note passes the secret scan", func(t *testing.T) {
		owner := memory.ProjectOwner(t.TempDir())
		note := memory.Note{ID: "legacy-note", Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "The build runs on port 8080.", Created: time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)}
		if _, err := e.ImportNote(ctx, note); err != nil {
			t.Fatal(err)
		}
		read, err := e.MemoryRead(ctx, "legacy-note")
		if err != nil || !read.Created.Equal(note.Created) {
			t.Fatalf("read = %+v (%v)", read, err)
		}
		note.ID, note.Text = "legacy-secret", "token sk-ant-"+strings.Repeat("a1", 15)
		if _, err := e.ImportNote(ctx, note); !errors.Is(err, memory.ErrSecret) {
			t.Fatalf("a note with a key: %v", err)
		}
	})
	t.Run("a notice reaches the inbox of a person", func(t *testing.T) {
		if err := e.Notify(ctx, "someone", group.Notice{Kind: "import", Text: "{}", Count: 3}); err != nil {
			t.Fatal(err)
		}
		facts, err := e.FindEvents(ctx, store.Query{Types: []event.Type{group.NoticeSent}})
		if err != nil || len(facts) != 1 || facts[0].Stream != "inbox:someone" {
			t.Fatalf("facts = %+v (%v)", facts, err)
		}
		notice, err := event.Decode[group.Notice](facts[0])
		if err != nil || notice.Kind != "import" || notice.Count != 3 || len(notice.To) != 1 || notice.To[0] != "someone" {
			t.Fatalf("notice = %+v (%v)", notice, err)
		}
	})
	t.Run("a record of an import is kept by key with a revision", func(t *testing.T) {
		if _, _, err := e.ReadImport(ctx, "v0.3"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("a record that was never written: %v", err)
		}
		if err := e.WriteImport(ctx, "v0.3", []byte(`{"n":1}`), 0); err != nil {
			t.Fatal(err)
		}
		body, rev, err := e.ReadImport(ctx, "v0.3")
		if err != nil || string(body) != `{"n":1}` || rev == 0 {
			t.Fatalf("body = %s rev = %d (%v)", body, rev, err)
		}
		if err := e.WriteImport(ctx, "v0.3", []byte(`{"n":2}`), 0); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("a write from a stale revision: %v", err)
		}
		if err := e.WriteImport(ctx, "v0.3", []byte(`{"n":2}`), rev); err != nil {
			t.Fatal(err)
		}
	})
}
