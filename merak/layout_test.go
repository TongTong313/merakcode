package merak

import (
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// placed lists where the Go packages of this module sit. The module root and the engine root are places too.
var placed = []string{
	"cmd", "cli", "server", "protocol", "storage", "cloudlink", "migrate", "diagnose", "testkit",
	"engine/infra", "engine/agent", "engine/collab", "engine/feature", "engine/scenario",
}

// groups only hold packages; they have no Go files of their own.
var groups = []string{"storage", "testkit", "engine/infra", "engine/agent", "engine/collab", "engine/feature", "engine/scenario"}

// pending stays empty: every package must belong to one of the declared locations.
var pending = []string{}

func TestEveryPackageSitsInItsPlace(t *testing.T) {
	var folders []string
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == "testdata" || name == "dist" || name == "node_modules" || name == "script" {
				return filepath.SkipDir
			}
			return nil
		}
		if folder := filepath.ToSlash(filepath.Dir(path)); strings.HasSuffix(path, ".go") && !slices.Contains(folders, folder) {
			folders = append(folders, folder)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, folder := range folders {
		if folder == "." || folder == "engine" || under(pending, folder) {
			continue
		}
		if slices.Contains(groups, folder) {
			t.Errorf("%s only groups packages and must hold no Go files", folder)
		}
		if !under(placed, folder) {
			t.Errorf("%s is not in its place", folder)
		}
	}
	for _, folder := range pending {
		if !slices.ContainsFunc(folders, func(found string) bool { return found == folder || strings.HasPrefix(found, folder+"/") }) {
			t.Errorf("%s is gone: delete it from the pending list", folder)
		}
	}
}

func under(places []string, folder string) bool {
	return slices.ContainsFunc(places, func(place string) bool { return folder == place || strings.HasPrefix(folder, place+"/") })
}
