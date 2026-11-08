package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestDebugWorkerRunsAConfiguredCommand(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "command.exe")
	cmd := process.Command(context.Background(), "", "go", "build", "-o", binary, "../../engine/worker/command/testdata/fakecommand")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	t.Chdir(dir)
	var output bytes.Buffer
	code := Run([]string{"debug", "worker", "--kind", "command", "--binary", binary, "Inspect"}, strings.NewReader(""), &output)
	if code != 0 || !strings.Contains(output.String(), `"synthesized":true`) {
		t.Fatalf("exit=%d output=%s", code, &output)
	}
	body, err := os.ReadFile(filepath.Join(dir, "input.txt"))
	if err != nil || string(body) != "Inspect" {
		t.Fatalf("prompt=%q err=%v", body, err)
	}
}

func TestDebugWorkerStreamsEventsAndPrintsItsReport(t *testing.T) {
	dir := t.TempDir()
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	cmd := process.Command(context.Background(), "", "go", "build", "-o", filepath.Join(dir, name), "../../engine/worker/claudecode/testdata/fakeclaude")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Chdir(dir)
	var output bytes.Buffer
	code := Run([]string{"debug", "worker", "--kind", "claude-code", "Check README"}, strings.NewReader(""), &output)
	if code != 0 {
		t.Fatalf("exit=%d output=%s", code, &output)
	}
	system, err := os.ReadFile(filepath.Join(dir, "system.txt"))
	if err != nil || !strings.Contains(string(system), "verdict") || !strings.Contains(string(system), "1200") {
		t.Fatalf("missing report instructions: %s %v", system, err)
	}
	decoder := json.NewDecoder(&output)
	var types []event.Type
	var report task.Report
	for decoder.More() {
		var line struct {
			event.Event
			Report *task.Report `json:"report"`
		}
		if err := decoder.Decode(&line); err != nil {
			t.Fatal(err)
		}
		if line.Report != nil {
			report = *line.Report
			continue
		}
		types = append(types, line.Type)
	}
	if len(types) < 5 || types[0] != "session.created" || types[len(types)-1] != "turn.finished" || report.Summary != "Checked README." || !report.Synthesized {
		t.Fatalf("types=%v report=%+v", types, report)
	}
}
