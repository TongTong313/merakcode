package engine_test

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
)

// The facade is what the server calls. testdata/facade.txt names every method it must keep, one per line.
func TestFacadeKeepsItsMethods(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "facade.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Fields(string(body))
	var got []string
	for method := range reflect.TypeFor[*engine.Engine]().Methods() {
		got = append(got, method.Name)
	}
	for _, name := range want {
		if !slices.Contains(got, name) {
			t.Errorf("the facade lost %s", name)
		}
	}
	for _, name := range got {
		if !slices.Contains(want, name) {
			t.Errorf("the facade gained %s: add it to testdata/facade.txt", name)
		}
	}
}

// testdata/fields.txt fixes the engine's private objects and lifecycle state.
// Domain state belongs to the corresponding package, not to the engine facade.
func TestEngineHoldsOnlyTheListedFields(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "fields.txt"))
	if err != nil {
		t.Fatal(err)
	}
	listed := strings.Fields(string(body))
	var held []string
	for field := range reflect.TypeFor[engine.Engine]().Fields() {
		held = append(held, field.Name)
	}
	for _, name := range held {
		if !slices.Contains(listed, name) {
			t.Errorf("the engine still holds %s", name)
		}
	}
	for _, name := range listed {
		if !slices.Contains(held, name) {
			t.Errorf("%s left the engine: delete it from testdata/fields.txt", name)
		}
	}
}

var bigLock = regexp.MustCompile(`(^|[^A-Za-z0-9_])(e|[a-z]+\.engine|[a-z]\.e)\.mu\.Lock\(\)`)

// testdata/biglock.txt stays at zero: the root package has no shared domain lock.
// Each domain owns the lock that protects its state.
func TestTheBigLockShrinks(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "biglock.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := strconv.Atoi(strings.TrimSpace(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	got := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		got += len(bigLock.FindAllIndex(source, -1))
	}
	if got != want {
		t.Errorf("the root package takes the big lock %d times, testdata/biglock.txt says %d", got, want)
	}
}
