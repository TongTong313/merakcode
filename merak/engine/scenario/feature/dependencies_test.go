package feature_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestEngineRequiresACredentialVault(t *testing.T) {
	deps := enginetest.Deps(t)
	deps.Vault = nil
	e, err := engine.New(deps)
	if e != nil {
		defer e.Close()
	}
	if err == nil {
		t.Fatal("engine started without a credential vault")
	}
}

func TestEngineRequiresAStore(t *testing.T) {
	deps := enginetest.Deps(t)
	deps.Store = nil
	e, err := engine.New(deps)
	if e != nil {
		defer e.Close()
	}
	if err == nil {
		t.Fatal("engine started without a store")
	}
}

func TestEngineUsesTheSuppliedSnapshotDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	project, snapshots := t.TempDir(), t.TempDir()
	file := filepath.Join(project, "existing.txt")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	deps := enginetest.Deps(t)
	deps.Workdir = project
	deps.Dirs.Snapshots = snapshots
	deps.Providers = map[string]model.Provider{"fake": fake.New(t,
		enginetest.IntegrationCall("write_file", map[string]any{"path": "existing.txt", "content": "changed"}),
		fake.Reply{Text: "Changed the file."},
	)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(ctx, conversation.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeTakeover})
	if err != nil {
		t.Fatal(err)
	}
	r := &enginetest.ChatRig{T: t, Engine: e, Context: ctx, Directory: project, ID: id}
	message := r.Say("Change the file")
	if body, err := os.ReadFile(file); err != nil || string(body) != "changed" {
		t.Fatalf("the turn wrote %q, %v", body, err)
	}
	if err := e.RevertSession(ctx, id, message); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(file); err != nil || string(body) != "original" {
		t.Fatalf("revert restored %q, %v", body, err)
	}
	if entries, err := os.ReadDir(snapshots); err != nil || len(entries) == 0 {
		t.Fatalf("the supplied snapshot directory is empty: %v", err)
	}
}
