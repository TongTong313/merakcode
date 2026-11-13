package server_test

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestAnExternalConversationReportsItsAgentAndIsTakenOverOnlyWithConfirmation(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude.exe")
	if out, err := exec.CommandContext(t.Context(), "go", "build", "-o", bin, "github.com/TongTong313/merakcode/merak/engine/worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Native."})}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { instance.Close() })
	client := connectAs(t, instance, protocol.LocalHuman, protocol.Capabilities{})
	ctx := t.Context()
	external := agent.DefaultWorker()
	external.Name, external.Mode = "Claude", permission.ModeTakeover
	external.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: bin}
	var saved agent.Agent
	if err := client.Call(ctx, "agent.save", map[string]any{"agent": external}, &saved); err != nil {
		t.Fatal(err)
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Agent: saved.ID, Workdir: t.TempDir()}, &created); err != nil {
		t.Fatal(err)
	}
	var found protocol.SessionExternalResult
	if err := client.Call(ctx, "session.external", protocol.SessionCancelParams{Session: created.Session}, &found); err != nil || found.Agent != saved.ID {
		t.Fatalf("external = %+v, %v", found, err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Hello"}}}, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		answers, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Session: created.Session}, Types: []event.Type{session.MessageCompleted}})
		if err == nil && len(answers) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the product did not answer")
		}
		time.Sleep(10 * time.Millisecond)
	}
	selection := &session.Selection{Provider: "fake", Model: "tiny"}
	err = client.Call(ctx, "session.takeover", protocol.SessionTakeoverParams{Session: created.Session, Selection: selection}, nil)
	if code(err) != errorcode.TakeoverNeedsConfirmation {
		t.Fatalf("takeover without confirmation: %v", err)
	}
	if err := client.Call(ctx, "session.takeover", protocol.SessionTakeoverParams{Session: created.Session, Confirm: true, Selection: selection}, nil); err != nil {
		t.Fatal(err)
	}
	var after protocol.SessionExternalResult
	if err := client.Call(ctx, "session.external", protocol.SessionCancelParams{Session: created.Session}, &after); err != nil || after.Agent != "" {
		t.Fatalf("external after takeover = %+v, %v", after, err)
	}
	var native protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "fake", Model: "tiny", Workdir: t.TempDir()}, &native); err != nil {
		t.Fatal(err)
	}
	var plain protocol.SessionExternalResult
	if err := client.Call(ctx, "session.external", protocol.SessionCancelParams{Session: native.Session}, &plain); err != nil || plain.Agent != "" {
		t.Fatalf("external of a native conversation = %+v, %v", plain, err)
	}
}
