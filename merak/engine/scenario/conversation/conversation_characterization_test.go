package conversation_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestSendingAfterRemovingTheProviderReportsItsFailure(t *testing.T) {
	r := enginetest.NewChatRig(t, conversation.SessionOptions{Model: "tiny"})
	r.Engine.SetProvider("fake", nil)
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: r.ID}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := r.Engine.Send(r.Context, r.ID, []model.Part{{Text: "Continue after removing the provider"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil || outcome.Stop != loop.Failed || outcome.Code != "MRK-2001" {
			t.Fatalf("outcome=%+v err=%v", outcome, err)
		}
	case <-r.Context.Done():
		t.Fatal("the missing provider did not finish the turn")
	}
}

func TestSteeringAnExternalConversationDoesNotRepeatADeliveredMessage(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	binary := filepath.Join(t.TempDir(), "claude.exe")
	if output, err := process.Command(ctx, "", "go", "build", "-o", binary, "github.com/TongTong313/merakcode/merak/engine/testdata/steered").CombinedOutput(); err != nil {
		t.Fatalf("build=%s %v", output, err)
	}
	directory := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"fake": fake.New(t)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	agent := definition.DefaultMerakCode()
	agent.Name, agent.Mode = "Steered", permission.ModeTakeover
	agent.Product = &definition.Product{Kind: definition.KindClaudeCode, Binary: binary}
	saved, err := e.SaveAgent(ctx, "owner", agent)
	if err != nil {
		t.Fatal(err)
	}
	r := &enginetest.ExternalRig{T: t, Engine: e, Context: ctx, Directory: directory, Agent: saved}
	id, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := r.Engine.Send(r.Context, id, []model.Part{{Text: "Start the external turn"}}); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, r.Context, "the external process to receive its first message", func() bool {
		_, err := os.Stat(filepath.Join(r.Directory, "ready"))
		return err == nil
	})
	if err := r.Engine.Send(r.Context, id, []model.Part{{Text: "Use the revised instruction"}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(r.Directory, "release"), []byte("finish"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil || outcome.Stop != loop.Answered {
			t.Fatalf("outcome=%+v err=%v", outcome, err)
		}
	case <-r.Context.Done():
		t.Fatal("the steered turn did not finish")
	}
	if err := r.Engine.TakeOverSession(r.Context, id, true, session.Selection{Provider: "fake", Model: "tiny"}); err != nil {
		t.Fatal(err)
	}
	history, err := r.Engine.ReadEvents(r.Context, event.Stream("session:"+id), 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	var messages []string
	for _, fact := range history {
		if fact.Type != session.MessageSent {
			continue
		}
		input, err := event.Decode[session.Input](fact)
		if err != nil {
			t.Fatal(err)
		}
		for _, part := range input.Message.Parts {
			if !part.Synthetic && part.Text != "" {
				messages = append(messages, part.Text)
			}
		}
	}
	if !reflect.DeepEqual(messages, []string{"Start the external turn", "Use the revised instruction"}) {
		t.Fatalf("messages=%q", messages)
	}
}
