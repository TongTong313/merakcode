package conversation_test

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestLongConversationRebuildsRepeatedlyAndStillReplays(t *testing.T) {
	const summary = "# Summary of earlier work\n## Goal\nContinue.\n## Constraints (verbatim)\nNone.\n## Decisions\nContinue.\n## Files touched\nNone.\n## Current state\nIn progress.\n## Open questions\nNone.\n## References\nNone.\n## Earlier\nPreserve earlier summaries."
	var replies []fake.Reply
	var frozenSystem string
	var frozenTools []model.ToolSpec
	for range 240 {
		replies = append(replies, fake.Reply{Text: summary, Expect: func(request model.Request) error {
			if frozenSystem == "" {
				frozenSystem = request.System
				frozenTools = request.Tools
			}
			if request.System != frozenSystem || !reflect.DeepEqual(request.Tools, frozenTools) {
				return fmt.Errorf("frozen prefix changed")
			}
			return nil
		}})
	}
	storage := memory.New()
	deps := enginetest.Deps(t)
	deps.Store = storage
	deps.Providers = map[string]model.Provider{"fake": fake.New(t, replies...)}
	deps.Workdir = t.TempDir()
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
	defer stop()
	rebuilds := 0
	for round := 0; round < 120; round++ {
		if err := e.Send(ctx, id, []model.Part{{Text: strings.Repeat("work ", 3000)}}); err != nil {
			t.Fatal(err)
		}
	turn:
		for {
			select {
			case fact := <-facts:
				if fact.Type == session.Rebuilt {
					rebuilds++
				}
				if fact.Type == loop.TurnFinished {
					outcome, err := event.Decode[loop.Outcome](fact)
					if err != nil || outcome.Stop != loop.Answered {
						t.Fatalf("round=%d outcome=%+v error=%v", round, outcome, err)
					}
					break turn
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	if rebuilds < 2 {
		t.Fatalf("rebuilds=%d", rebuilds)
	}
	e.Close()
	manager := session.NewManager(storage, event.NewBus(storage, time.Now, event.NewID))
	loaded, err := manager.Load(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := storage.Read(ctx, event.Stream("session:"+id), 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	var replay session.State
	for _, fact := range stored {
		if err := session.Fold(&replay, fact); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(loaded.Messages, replay.Messages) || loaded.SummaryID == "" {
		t.Fatal("snapshot and complete replay disagree")
	}
}
