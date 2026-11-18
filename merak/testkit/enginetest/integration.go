package enginetest

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
)

func FixtureGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := process.Command(context.Background(), dir, "git", args...)
	body, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, body)
	}
	return strings.TrimSpace(string(body))
}

func IntegrationRepository(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
			if err == nil && entry.Type().IsRegular() {
				_ = os.Chmod(path, 0600)
			}
			return nil
		})
	})
	FixtureGit(t, dir, "init", "-b", "main")
	FixtureGit(t, dir, "config", "user.name", "Fixture")
	FixtureGit(t, dir, "config", "user.email", "fixture@example.invalid")
	FixtureGit(t, dir, "config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Baseline\n"), 0600); err != nil {
		t.Fatal(err)
	}
	FixtureGit(t, dir, "add", ".")
	FixtureGit(t, dir, "commit", "-m", "Baseline fixture")
	return dir
}

func IntegrationCall(name string, input any) fake.Reply {
	body, _ := json.Marshal(input)
	return fake.Reply{Calls: []model.ToolCall{{ID: string(event.NewID()), Name: name, Input: body}}}
}
