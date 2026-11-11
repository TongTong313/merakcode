package mcp_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestAServersPromptsAreListedAndExpandedWithTheirArguments(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	binary := filepath.Join(t.TempDir(), "promptserver.exe")
	if out, err := process.Command(ctx, "", "go", "build", "-o", binary, "./testdata/promptserver").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	command := exec.CommandContext(ctx, binary)
	command.Stderr = os.Stderr
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stdin.Close(); _ = command.Wait() }()
	client, err := mcp.Connect(ctx, "docs", stdout, stdin)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	prompts, err := client.Prompts(ctx)
	if err != nil || len(prompts) != 2 {
		t.Fatalf("prompts=%+v err=%v", prompts, err)
	}
	if prompts[0].Name != "explain" || prompts[0].Description != "Explain a topic" || len(prompts[0].Arguments) != 1 || prompts[0].Arguments[0].Name != "topic" || !prompts[0].Arguments[0].Required {
		t.Fatalf("prompt=%+v", prompts[0])
	}
	text, err := client.GetPrompt(ctx, "explain", map[string]string{"topic": "closures"})
	if err != nil || text != "Please explain closures in simple words." {
		t.Fatalf("text=%q err=%v", text, err)
	}
	if _, err := client.GetPrompt(ctx, "nope", nil); err == nil {
		t.Fatal("an unknown prompt was expanded")
	}
}
