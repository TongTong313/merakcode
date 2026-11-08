package tool_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func searchWorkspace(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"main.go": "package main\n", "src/lib.go": "package lib\nTODO: test this\n", "notes.txt": "TODO: document this\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestGlobFindsFilesAcrossDirectoriesInOrder(t *testing.T) {
	dir := searchWorkspace(t)
	result, err := (tool.Glob{}).Run(context.Background(), tool.Call{Input: []byte(`{"pattern":"**/*.go"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "main.go\nsrc/lib.go" {
		t.Fatalf("glob = %+v, error = %v", result, err)
	}
}

func TestGrepReturnsMatchingLinesWithPathsAndLineNumbers(t *testing.T) {
	dir := searchWorkspace(t)
	result, err := (tool.Grep{}).Run(context.Background(), tool.Call{Input: []byte(`{"pattern":"TODO: (test|document)"}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "notes.txt:1:TODO: document this\nsrc/lib.go:2:TODO: test this" {
		t.Fatalf("grep = %+v, error = %v", result, err)
	}
}

func TestListDirShowsOnlyImmediateEntries(t *testing.T) {
	dir := searchWorkspace(t)
	result, err := (tool.ListDir{}).Run(context.Background(), tool.Call{Input: []byte(`{"path":"."}`), Env: tool.Env{Workdir: dir}})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "main.go\nnotes.txt\nsrc/" {
		t.Fatalf("list_dir = %+v, error = %v", result, err)
	}
}
