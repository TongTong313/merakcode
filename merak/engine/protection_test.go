package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestEngineBuiltinPreservesProtectionAndRecordsFailure(t *testing.T) {
	workspace := t.TempDir()
	path := filepath.Join(workspace, "merakcode.json")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "bash", Input: json.RawMessage(`{"command":"printf changed > merakcode.json"}`)}}}, fake.Reply{Text: "finished"})
	e, err := engine.New(engine.Deps{Workdir: workspace, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err := e.Chat(ctx, "fixture", "Run the command"); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "original" {
		t.Fatalf("protected file=%q error=%v", body, err)
	}
	facts, err := e.FindEvents(ctx, store.Query{Types: []event.Type{tool.Completed}, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		result, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		if result.Code == engineProtectionFailureCode() && result.IsError {
			return
		}
	}
	t.Fatal("builtin protection failure was not recorded")
}

func init() {
	if len(os.Args) == 3 && os.Args[1] == "--merak-protection-event-fixture" {
		if err := os.WriteFile(os.Args[2], []byte("modified"), 0600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Print("finished")
		os.Exit(0)
	}
}

func TestEngineRestoresMemberChangesAndPublishesProtectionFailure(t *testing.T) {
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(workspace, "merakcode.json")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Name = "Protection worker"
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-protection-event-fixture", path}}
	run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: event.NewID(), Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	_, runErr := run.Wait(t.Context())
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "original" {
		t.Fatalf("protected file=%q error=%v", body, err)
	}
	if runErr == nil {
		t.Fatal("protection change was reported as success")
	}
	for fact := range run.Events() {
		if fact.Type != tool.Completed {
			continue
		}
		completion, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		if completion.Code == engineProtectionFailureCode() && completion.IsError && completion.MemberName == p.Name {
			for _, part := range completion.Parts {
				if strings.Contains(part.Text, path) {
					return
				}
			}
		}
	}
	t.Fatal("missing protection failure with member and path in tool.completed")
}

func engineProtectionFailureCode() string {
	if runtime.GOOS == "darwin" {
		return "MRK-5009"
	}
	return "MRK-5007"
}
