package workspace_test

import (
	"context"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProjectLeaseBlocksConflictingClaimsUntilRelease(t *testing.T) {
	for _, tc := range []struct {
		name, first, next string
		blocked           bool
	}{
		{"inplace excludes inplace", "inplace", "inplace", true},
		{"inplace excludes folder", "inplace", "folder", true},
		{"folder excludes inplace", "folder", "inplace", true},
		{"folders coexist", "folder", "folder", false},
		{"none does not need a lease", "inplace", "none", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			project := t.TempDir()
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			manager := workspace.New(ctx, storage, bus, event.NewID)
			defer manager.Close()
			first, err := manager.ForClaim(ctx, project, task.Claim{ID: "first", Task: "first", Member: "a"}, task.Card{ID: "first", Group: "group", Workspace: tc.first})
			if err != nil {
				t.Fatal(err)
			}
			manager.Close()
			manager = workspace.New(ctx, storage, bus, event.NewID)
			defer manager.Close()
			claim := task.Claim{ID: "next", Task: "next", Member: "b"}
			card := task.Card{ID: "next", Group: "other-group", Workspace: tc.next}
			if tc.blocked {
				deadline, cancel := context.WithTimeout(ctx, 40*time.Millisecond)
				_, err := manager.ForClaim(deadline, project, claim, card)
				cancel()
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("conflicting workspace started: %v", err)
				}
				if err := manager.Release(ctx, first); err != nil {
					t.Fatal(err)
				}
			}
			deadline, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			next, err := manager.ForClaim(deadline, project, claim, card)
			if err != nil || next.Kind != tc.next {
				t.Fatalf("next=%+v err=%v", next, err)
			}
		})
	}
}

func TestFinishedClaimReleasesItsLeaseAndReworkReusesItsFolder(t *testing.T) {
	ctx := context.Background()
	project := t.TempDir()
	storage := memory.New()
	manager := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	claim := task.Claim{ID: "folder", Task: "folder", Member: "a"}
	card := task.Card{ID: "folder", Group: "group", Workspace: "folder"}
	folder, err := manager.ForClaim(ctx, project, claim, card)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder.Directory, "draft.txt"), []byte("Draft"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := manager.EndClaim(ctx, folder); err != nil {
		t.Fatal(err)
	}
	inplace, err := manager.ForClaim(ctx, project, task.Claim{ID: "inplace", Task: "inplace", Member: "b"}, task.Card{ID: "inplace", Group: "group", Workspace: "inplace"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.EndClaim(ctx, inplace); err != nil {
		t.Fatal(err)
	}
	resumed, err := manager.ForClaim(ctx, project, claim, card)
	if err != nil || resumed.ID != folder.ID || resumed.Directory != folder.Directory {
		t.Fatalf("resumed=%+v err=%v", resumed, err)
	}
	body, err := os.ReadFile(filepath.Join(resumed.Directory, "draft.txt"))
	if err != nil || string(body) != "Draft" {
		t.Fatalf("draft=%q err=%v", body, err)
	}
	deadline, cancel := context.WithTimeout(ctx, 40*time.Millisecond)
	defer cancel()
	if _, err := manager.ForClaim(deadline, project, task.Claim{ID: "other", Task: "other", Member: "b"}, task.Card{ID: "other", Group: "group", Workspace: "inplace"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("resumed folder did not hold its lease: %v", err)
	}
}

func TestWorktreeCanStartWhileAnInplaceClaimHoldsTheProjectLease(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	project := repository(t)
	storage := memory.New()
	manager := workspace.New(ctx, storage, event.NewBus(storage, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	if _, err := manager.ForClaim(ctx, project, task.Claim{ID: "exclusive", Task: "exclusive", Member: "a"}, task.Card{ID: "exclusive", Group: "group", Workspace: "inplace"}); err != nil {
		t.Fatal(err)
	}
	isolated, err := manager.ForClaim(ctx, project, task.Claim{ID: "isolated", Task: "isolated", Member: "b"}, task.Card{ID: "isolated", Group: "group", Workspace: "worktree", Base: "HEAD"})
	if err != nil || isolated.Kind != workspace.KindWorktree || isolated.Directory == project {
		t.Fatalf("worktree=%+v err=%v", isolated, err)
	}
}
