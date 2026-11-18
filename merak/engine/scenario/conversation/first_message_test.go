package conversation_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// The first message of a conversation carries the date and the recalled notes for the model; they are marked as
// synthetic so a client shows only what the person wrote, and the model still reads them.
func TestTheDateAndTheRecalledNotesOfTheFirstMessageAreSyntheticParts(t *testing.T) {
	ctx := context.Background()
	dir, durable := t.TempDir(), storage.New()
	owner := memory.ProjectOwner(dir)
	if _, err := memory.New(durable).Remember(ctx, memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: "fact", Text: "Use tabs"}); err != nil {
		t.Fatal(err)
	}
	var seen string
	provider := fake.New(t, fake.Reply{Text: "Hi.", Expect: func(req model.Request) error {
		for _, message := range req.Messages {
			for _, part := range message.Parts {
				seen += part.Text + "\n"
			}
		}
		return nil
	}})
	deps := enginetest.Deps(t)
	deps.Store = durable
	deps.Workdir = dir
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigureMemory(conversation.MemorySettings{AutoRecall: true})
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	turns, stop := e.Subscribe(event.Filter{Types: []event.Type{"turn.finished"}})
	defer stop()
	if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-turns:
	case <-time.After(10 * time.Second):
		t.Fatal("the turn did not finish")
	}
	if !strings.Contains(seen, "Current date and time:") || !strings.Contains(seen, "Use tabs") {
		t.Fatalf("the model must still read the date and the notes: %q", seen)
	}
	facts, err := durable.Read(ctx, event.Stream("session:"+id), 1, 1000)
	if err != nil {
		t.Fatal(err)
	}
	var state session.State
	for _, fact := range facts {
		if err := session.Fold(&state, fact); err != nil {
			t.Fatal(err)
		}
	}
	var visible, synthetic []string
	for _, part := range state.Messages[0].Parts {
		if part.Synthetic {
			synthetic = append(synthetic, part.Text)
		} else {
			visible = append(visible, part.Text)
		}
	}
	if len(visible) != 1 || visible[0] != "Hello" {
		t.Fatalf("what the person wrote must be the only visible part: %q", visible)
	}
	joined := strings.Join(synthetic, "\n")
	if len(synthetic) != 2 || !strings.Contains(joined, "Current date and time:") || !strings.Contains(joined, "Use tabs") {
		t.Fatalf("synthetic parts = %q, want the date and the notes", synthetic)
	}
}
