package engine_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// frozen lists the root package's assembly, facade and lifecycle files.
// New engine code belongs in a package of its own under engine/.
var frozen = []string{
	"engine.go",
	"facade_agent.go",
	"facade_collab.go",
	"facade_feature.go",
	"recovery.go",
	"shutdown.go",
}

// pendingTests stays empty: only architecture, facade and layer tests belong in the root package.
var pendingTests = []string{}

func TestTheRootPackageGetsNoNewFiles(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go") {
			files = append(files, filepath.ToSlash(name))
		}
	}
	for _, name := range files {
		if !slices.Contains(frozen, name) {
			t.Errorf("%s is new: put new code in a package under engine/", name)
		}
	}
	for _, name := range frozen {
		if !slices.Contains(files, name) {
			t.Errorf("%s was removed: delete it from the frozen list", name)
		}
	}

	var testFiles []string
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasSuffix(name, "_test.go") {
			testFiles = append(testFiles, name)
		}
	}
	keptTests := []string{"architecture_test.go", "facade_test.go", "layers_test.go"}
	for _, name := range testFiles {
		if !slices.Contains(keptTests, name) && !slices.Contains(pendingTests, name) {
			t.Errorf("%s is a scenario test: move it out of the root package", name)
		}
	}
	for _, name := range pendingTests {
		if !slices.Contains(testFiles, name) {
			t.Errorf("%s left the root package: delete it from pendingTests", name)
		}
	}
}
