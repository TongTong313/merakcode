package watch_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

func TestFilesReportAddedEditedAndRemovedPathsButExcludeClaimWorkspaces(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	for _, name := range []string{"guide.md", "removed.txt", ".git/index", "node_modules/lib.js", ".merak/work/task/output.txt", "claims/worker/output.txt"} {
		write(t, directory, name, "Original\n")
	}
	watcher := watch.NewFiles(directory, []string{filepath.Join(directory, "claims", "worker")})
	if scan, err := watcher.Poll(ctx); err != nil || len(scan.Paths) != 0 || scan.Overload != nil {
		t.Fatalf("baseline=%+v, %v", scan, err)
	}
	write(t, directory, "guide.md", "Revised guide\n")
	write(t, directory, "docs/new.md", "New document\n")
	if err := os.Remove(filepath.Join(directory, "removed.txt")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{".git/index", "node_modules/lib.js", ".merak/work/task/output.txt", "claims/worker/output.txt"} {
		write(t, directory, name, "Ignored change\n")
	}
	scan, err := watcher.Poll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"docs/new.md", "guide.md", "removed.txt"}; !reflect.DeepEqual(scan.Paths, want) {
		t.Fatalf("paths=%v, want %v", scan.Paths, want)
	}
	if scan, err := watcher.Poll(ctx); err != nil || len(scan.Paths) != 0 {
		t.Fatalf("idle=%+v, %v", scan, err)
	}
}

func TestFilesFlagAnOversizedProjectOnceWithoutPublishingAPartialScan(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	write(t, directory, "existing.txt", "Existing\n")
	watcher := watch.NewFiles(directory, nil)
	if _, err := watcher.Poll(ctx); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 50001; index++ {
		write(t, directory, fmt.Sprintf("many/%03d/%03d.txt", index/500, index%500), "")
	}
	scan, err := watcher.Poll(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if scan.Overload == nil || scan.Overload.Files <= 50000 && scan.Overload.Duration <= time.Second {
		t.Fatalf("missing overload: %+v", scan.Overload)
	}
	if len(scan.Paths) != 0 {
		t.Fatalf("published a partial scan of %d paths", len(scan.Paths))
	}
	if next, err := watcher.Poll(ctx); err != nil || next.Overload != nil || len(next.Paths) != 0 {
		t.Fatalf("repeated overload=%+v, %v", next, err)
	}
	if err := os.RemoveAll(filepath.Join(directory, "many")); err != nil {
		t.Fatal(err)
	}
	write(t, directory, "after.txt", "After overload\n")
	if next, err := watcher.Poll(ctx); err != nil || !reflect.DeepEqual(next.Paths, []string{"after.txt"}) {
		t.Fatalf("recovered=%+v, %v", next, err)
	}
}

func TestChangingClaimExclusionsDoesNotReportClaimWritesAsExternalChanges(t *testing.T) {
	for _, name := range []string{"claim directory", "inplace project"} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			directory := t.TempDir()
			excluded, file := filepath.Join(directory, "claim"), "claim/output.txt"
			if name == "inplace project" {
				excluded, file = directory, "output.txt"
			}
			write(t, directory, file, "Original")
			watcher := watch.NewFiles(directory, nil)
			if _, err := watcher.Poll(ctx); err != nil {
				t.Fatal(err)
			}
			watcher.SetExcluded([]string{excluded})
			write(t, directory, file, "Claim write")
			if scan, err := watcher.Poll(ctx); err != nil || len(scan.Paths) != 0 {
				t.Fatalf("active claim=%+v, %v", scan, err)
			}
			watcher.SetExcluded(nil)
			if scan, err := watcher.Poll(ctx); err != nil || len(scan.Paths) != 0 {
				t.Fatalf("released claim=%+v, %v", scan, err)
			}
			write(t, directory, file, "External write after the claim")
			if scan, err := watcher.Poll(ctx); err != nil || !reflect.DeepEqual(scan.Paths, []string{file}) {
				t.Fatalf("external=%+v, %v", scan, err)
			}
		})
	}
}
