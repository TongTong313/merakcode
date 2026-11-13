package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestEngineSandboxBuiltinBashCannotWriteOutsideItsWorkspace(t *testing.T) {
	workspace, outside := t.TempDir(), filepath.Join(t.TempDir(), "outside.txt")
	input, _ := json.Marshal(map[string]string{"command": fmt.Sprintf("printf inside > inside.txt; printf outside > %q", outside)})
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "bash", Name: "bash", Input: input}}}, fake.Reply{Text: "Finished"})
	e, err := engine.New(engine.Deps{Workdir: workspace, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := e.Chat(ctx, "fixture", "Run the command"); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(workspace, "inside.txt")); err != nil || string(body) != "inside" {
		t.Fatalf("workspace write = %q, %v", body, err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("approved bash escaped its workspace: %v", err)
	}
}

func TestEngineSandboxMembersCannotReadCredentialDirectories(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, name := range []string{".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker", ".config/gcloud", ".config/gh"} {
		path := filepath.Join(home, name, "credential")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("fixture credential\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		for _, kind := range []string{"builtin", "command"} {
			t.Run(kind+"/"+name, func(t *testing.T) {
				workspace := t.TempDir()
				command := fmt.Sprintf("printf ran > ran.txt; if IFS= read -r value < %q; then printf '%%s' \"$value\" > copied.txt; fi", path)
				input, _ := json.Marshal(map[string]string{"command": command})
				provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "bash", Name: "bash", Input: input}}}, fake.Reply{Text: "Finished"})
				e, err := engine.New(engine.Deps{Workdir: workspace, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
					return permission.Reply{Decision: permission.Allow}, nil
				}})
				if err != nil {
					t.Fatal(err)
				}
				defer e.Close()
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				if kind == "builtin" {
					if _, err := e.Chat(ctx, "fixture", "Read credentials"); err != nil {
						t.Fatal(err)
					}
				} else {
					p := agent.DefaultMerakCode()
					p.Product = &agent.Product{Kind: worker.KindCommand, Binary: "/bin/bash", Args: []string{"-c", command}}
					run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "credential-check", Workdir: workspace})
					if err != nil {
						t.Fatal(err)
					}
					_, err = run.Wait(ctx)
					var denial *sandbox.DenialError
					if !errors.As(err, &denial) || !strings.Contains(denial.Details, path) {
						t.Fatalf("missing credential denial: path=%s error=%v", path, err)
					}
				}
				if body, err := os.ReadFile(filepath.Join(workspace, "ran.txt")); err != nil || string(body) != "ran" {
					t.Fatalf("member did not run: %q, %v", body, err)
				}
				if _, err := os.Stat(filepath.Join(workspace, "copied.txt")); !os.IsNotExist(err) {
					t.Fatalf("member read credential directory %s: %v", name, err)
				}
			})
		}
	}
}

func TestEngineSandboxBuiltinBashRequestsNetworkApproval(t *testing.T) {
	input, _ := json.Marshal(map[string]string{"command": fmt.Sprintf("%q --merak-engine-network-fixture http://unlisted.example/", os.Args[0])})
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "bash", Name: "bash", Input: input}}}, fake.Reply{Text: "Finished"})
	var asked atomic.Int32
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fixture": provider}, Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		if request.Kind == "network" {
			if request.Host != "unlisted.example" {
				t.Errorf("network host = %q", request.Host)
			}
			asked.Add(1)
			return permission.Reply{Decision: permission.Deny}, nil
		}
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	if _, err := e.Chat(ctx, "fixture", "Connect to the host"); err != nil {
		t.Fatal(err)
	}
	if asked.Load() != 1 {
		t.Fatalf("network approvals = %d, want 1", asked.Load())
	}
}

func TestEngineSandboxPassesOnlyDeclaredMemberEnvironment(t *testing.T) {
	t.Setenv("MERAK_UNLISTED_FIXTURE", "must not pass")
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.Product = &agent.Product{Kind: worker.KindCommand, Binary: "/bin/bash", Args: []string{"-c", `printf '%s|%s' "$MEMBER_SETTING" "$MERAK_UNLISTED_FIXTURE"`}, Env: map[string]string{"MEMBER_SETTING": "explicit value"}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "environment-check", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "explicit value|" {
		t.Fatalf("member environment output = %q, %v", report.Summary, err)
	}
}
