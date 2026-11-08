package workspace_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFolderCopiesDeclaredInputsAndPublishesIndependentArtifacts(t *testing.T) {
	ctx := context.Background()
	project := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"docs/input.md": "Original input", "unrelated.txt": "Unrelated"} {
		if err := os.WriteFile(filepath.Join(project, name), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	storage := memory.New()
	manager := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	ws, err := manager.ForClaim(ctx, project, task.Claim{ID: "claim", Task: "task", Member: "worker"}, task.Card{ID: "task", Group: "group", Workspace: workspace.KindFolder, Inputs: []string{"docs/input.md"}})
	if err != nil {
		t.Fatal(err)
	}
	if ws.Directory != filepath.Join(project, ".merak", "work", "task-worker") {
		t.Fatalf("directory=%s", ws.Directory)
	}
	input, err := os.ReadFile(filepath.Join(ws.Directory, "docs", "input.md"))
	if err != nil || string(input) != "Original input" {
		t.Fatalf("input=%q err=%v", input, err)
	}
	if _, err := os.Stat(filepath.Join(ws.Directory, "unrelated.txt")); !os.IsNotExist(err) {
		t.Fatalf("undeclared input copied: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ws.Directory, "docs", "input.md"), []byte("Revised document"), 0600); err != nil {
		t.Fatal(err)
	}
	ids, err := manager.Publish(ctx, ws, []tool.Artifact{{Path: "docs/input.md", Title: "Revised document"}})
	if err != nil || len(ids) != 1 {
		t.Fatalf("ids=%v err=%v", ids, err)
	}
	original, err := os.ReadFile(filepath.Join(project, "docs", "input.md"))
	if err != nil || string(original) != "Original input" {
		t.Fatalf("project changed: %q %v", original, err)
	}
	blob, err := storage.Fetch(ctx, "blob", string(ids[0]))
	if err != nil || string(blob.Body) != "Revised document" {
		t.Fatalf("artifact=%q err=%v", blob.Body, err)
	}
	published, err := storage.Find(ctx, store.Query{Scope: event.Scope{Group: "group", Task: "task"}, Types: []event.Type{"artifact.published"}})
	if err != nil || len(published) != 1 {
		t.Fatalf("events=%v err=%v", published, err)
	}
	var artifact workspace.Published
	artifact, err = event.Decode[workspace.Published](published[0])
	if err != nil || artifact.ID != ids[0] {
		t.Fatalf("published=%+v err=%v", artifact, err)
	}
	body, err := os.ReadFile(filepath.Join(project, ".merak", "artifacts", "task", artifact.Path))
	if err != nil || string(body) != "Revised document" {
		t.Fatalf("library=%q err=%v", body, err)
	}
	if err := manager.Release(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ws.Directory); !os.IsNotExist(err) {
		t.Fatalf("folder remained: %v", err)
	}
	blob, err = storage.Fetch(ctx, "blob", string(ids[0]))
	if err != nil || string(blob.Body) != "Revised document" {
		t.Fatal("release removed published artifact")
	}
}

func TestFolderInputsAndArtifactsCannotEscapeTheirRoots(t *testing.T) {
	for _, kind := range []string{"parent path", "absolute path", "outside symlink"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			project, outside := t.TempDir(), t.TempDir()
			external := filepath.Join(outside, "external.txt")
			if err := os.WriteFile(external, []byte("Outside"), 0600); err != nil {
				t.Fatal(err)
			}
			name := "../external.txt"
			if kind == "absolute path" {
				name = external
			}
			if kind == "outside symlink" {
				name = "link.txt"
				if err := os.Symlink(external, filepath.Join(project, name)); err != nil {
					t.Skipf("symlink unavailable: %v", err)
				}
			}
			storage := memory.New()
			manager := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
			defer manager.Close()
			claim := task.Claim{ID: "claim", Task: "task", Member: "worker"}
			card := task.Card{ID: "task", Group: "group", Workspace: "folder", Inputs: []string{name}}
			if _, err := manager.ForClaim(ctx, project, claim, card); err == nil {
				t.Fatal("escaped input was copied")
			}
			card.Inputs = nil
			ws, err := manager.ForClaim(ctx, project, claim, card)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "outside symlink" {
				if err := os.Symlink(external, filepath.Join(ws.Directory, name)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := manager.Publish(ctx, ws, []tool.Artifact{{Path: name}}); err == nil {
				t.Fatal("escaped artifact was published")
			}
			docs, err := storage.List(ctx, "blob", "")
			if err != nil || len(docs) != 0 {
				t.Fatalf("escaped blob=%v err=%v", docs, err)
			}
			body, err := os.ReadFile(external)
			if err != nil || string(body) != "Outside" {
				t.Fatalf("outside file changed: %q %v", body, err)
			}
		})
	}
}
