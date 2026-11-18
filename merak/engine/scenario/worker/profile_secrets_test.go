package worker_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	storememory "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestAnExternalAgentKeepsItsEnvironmentValuesInTheCredentialVault(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "github.com/TongTong313/merakcode/merak/engine/collab/worker/command/testdata/fakecommand").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	storage := storememory.New()
	deps := enginetest.Deps(t)
	deps.Store = storage
	deps.Vault = vault.NewFile(t.TempDir())
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := definition.DefaultMerakCode()
	p.Name, p.Mode = "External", permission.ModeTakeover
	p.Product = &definition.Product{Kind: definition.KindCommand, Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "env", "MERAKCODE_FIXTURE_ECHO": "OPENAI_API_KEY", "OPENAI_API_KEY": "secret-value"}}
	saved, err := e.SaveAgent(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Product.Env["OPENAI_API_KEY"] != "" {
		t.Fatalf("the saved profile returns the secret: %v", saved.Product.Env)
	}
	doc, err := storage.Fetch(ctx, "agent", string(saved.ID))
	if err != nil || strings.Contains(string(doc.Body), "secret-value") || !strings.Contains(string(doc.Body), "OPENAI_API_KEY") {
		t.Fatalf("stored profile = %s, %v", doc.Body, err)
	}
	listed, err := e.ListAgents(ctx, "owner")
	if err != nil {
		t.Fatal(err)
	}
	var found *definition.Agent
	for i := range listed {
		if listed[i].ID == saved.ID {
			found = &listed[i]
		}
	}
	if found == nil || found.Product.Env["OPENAI_API_KEY"] != "" {
		t.Fatalf("listed profile = %+v", found)
	}

	// saving again with the value left empty keeps the stored one
	if _, err := e.SaveAgent(ctx, "owner", *found); err != nil {
		t.Fatal(err)
	}
	workdir := t.TempDir()
	run, err := e.StartWorker(ctx, *found, worker.Assignment{Session: "secrets", Claim: task.Claim{ID: "claim"}, Workdir: workdir, Packet: "Report"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(workdir, "env.txt"))
	if err != nil || string(got) != "secret-value" {
		t.Fatalf("the process saw %q, %v", got, err)
	}
	facts, err := e.FindEvents(ctx, store.Query{})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		if strings.Contains(string(fact.Payload), "secret-value") {
			t.Fatalf("the secret reached an event: %s", fact.Type)
		}
	}
}
