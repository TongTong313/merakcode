package engine_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

var layers = map[string]int{"infra": 0, "agent": 1, "collab": 2, "feature": 3}

// known stays empty: every engine import must follow the layer and package boundary rules.
var known = []string{}

// diskWriters lists direct writers and their directory sources, including the plan's scoped exceptions.
// Project files and Git metadata retain their existing path and symlink resolution rules.
var diskWriters = []string{
	"engine/agent/tool",          // User files: project files and external paths allowed by the existing permission flow.
	"engine/collab/execution",    // Startup directories: temporary connection checks.
	"engine/collab/worker/pi",    // Startup directories: temporary product extensions.
	"engine/feature/admin/rules", // User files: project rules.
	"engine/feature/admin/skill", // User files: project skills. Startup directories: cache. Exception: configured global skills.
	"engine/feature/code",        // User files: project edits. Startup directories: worktrees.
	"engine/feature/review",      // User files: restored project files.
	"engine/feature/snapshot",    // Startup directories: snapshots.
	"engine/infra/git",           // User files: project Git metadata, including a separate common directory.
	"engine/infra/sandbox",       // Startup directories: state and setup files. Exception: external-product user state.
}

func TestEngineDiskWritesStayInListedPackages(t *testing.T) {
	writes := []string{"WriteFile", "Create", "OpenFile", "MkdirAll", "Rename", "MkdirTemp", "CreateTemp"}
	var found []string
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			return err
		}
		var names []string
		for _, spec := range file.Imports {
			imported, err := strconv.Unquote(spec.Path.Value)
			if err != nil || imported != "os" {
				continue
			}
			name := "os"
			if spec.Name != nil {
				name = spec.Name.Name
			}
			names = append(names, name)
		}
		pkg := "engine"
		if folder := filepath.ToSlash(filepath.Dir(path)); folder != "." {
			pkg += "/" + folder
		}
		ast.Inspect(file, func(node ast.Node) bool {
			// Function references also cover parenthesized calls, aliases and callbacks.
			name := ""
			switch function := node.(type) {
			case *ast.SelectorExpr:
				if source, ok := function.X.(*ast.Ident); ok && source.Obj == nil && slices.Contains(names, source.Name) {
					name = function.Sel.Name
				}
			case *ast.Ident:
				if function.Obj == nil && slices.Contains(names, ".") {
					name = function.Name
				}
			}
			if slices.Contains(writes, name) && !slices.Contains(found, pkg) {
				found = append(found, pkg)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range found {
		if !slices.Contains(diskWriters, pkg) {
			t.Errorf("%s writes to disk", pkg)
		}
	}
	for _, pkg := range diskWriters {
		if !slices.Contains(found, pkg) {
			t.Errorf("%s no longer writes to disk: delete it from the disk writers list", pkg)
		}
	}
}

func TestLayersPointDownward(t *testing.T) {
	const module = "github.com/TongTong313/merakcode/merak"
	var found []string
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		from := "engine"
		if folder := filepath.ToSlash(filepath.Dir(path)); folder != "." {
			from += "/" + folder
		}
		for _, spec := range file.Imports {
			to, _ := strconv.Unquote(spec.Path.Value)
			// The module root package holds nothing but the product version.
			to, owned := strings.CutPrefix(to, module+"/")
			if violation := from + " -> " + to; owned && breaksLayering(from, to) && !slices.Contains(found, violation) {
				found = append(found, violation)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, violation := range found {
		if !slices.Contains(known, violation) {
			t.Errorf("%s breaks the layering", violation)
		}
	}
	for _, violation := range known {
		if !slices.Contains(found, violation) {
			t.Errorf("%s is fixed: delete it from the known list", violation)
		}
	}
}

func breaksLayering(from, to string) bool {
	if to != "engine" && !strings.HasPrefix(to, "engine/") {
		return true
	}
	if from == "engine" {
		return false
	}
	return to == "engine" || layerOf(to) > layerOf(from)
}

func layerOf(pkg string) int {
	if parts := strings.Split(pkg, "/"); len(parts) > 1 {
		if layer, ok := layers[parts[1]]; ok {
			return layer
		}
	}
	return -1
}
