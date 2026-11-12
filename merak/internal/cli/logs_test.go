package cli

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuffer lets a test read what a following command has written so far.
type lockedBuffer struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.data.String()
}

func writeLog(t *testing.T, home, mode, component, file string, lines ...string) {
	t.Helper()
	dir := filepath.Join(home, "logs", mode, component)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func logLine(clock, component, message string) string {
	return fmt.Sprintf(`{"time":"2026-11-12T%s.000000000Z","level":"INFO","msg":%q,"component":%q}`, clock, message, component)
}

func TestLogsPrintsTheLatestLinesOfAllComponentsInTimeOrder(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	writeLog(t, home, "production", "engine", "1-1.ndjson", logLine("10:00:00", "engine", "engine one"), logLine("10:00:03", "engine", "engine two"), logLine("10:00:05", "engine", "engine three"))
	writeLog(t, home, "production", "cli", "2-2.ndjson", logLine("10:00:01", "cli", "cli one"), logLine("10:00:04", "cli", "cli two"))
	writeLog(t, home, "development", "engine", "3-3.ndjson", logLine("09:00:00", "engine", "development line"))
	for _, test := range []struct {
		name string
		args []string
		want []string
	}{
		{"last lines across components", []string{"logs", "--lines", "3"}, []string{"engine two", "cli two", "engine three"}},
		{"all lines by default", []string{"logs"}, []string{"engine one", "cli one", "engine two", "cli two", "engine three"}},
		{"one component", []string{"logs", "--component", "cli"}, []string{"cli one", "cli two"}},
		{"development logs", []string{"logs", "--development"}, []string{"development line"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			if code := Run(test.args, strings.NewReader(""), &out); code != 0 {
				t.Fatalf("code=%d output=%s", code, out.String())
			}
			lines := strings.Split(strings.TrimSpace(out.String()), "\n")
			if len(lines) != len(test.want) {
				t.Fatalf("lines=%d want=%d:\n%s", len(lines), len(test.want), out.String())
			}
			for i, want := range test.want {
				if !strings.Contains(lines[i], want) {
					t.Errorf("line %d = %q, want %q", i, lines[i], want)
				}
			}
		})
	}
}

func TestLogsSaysThereAreNoLogsYetInBothLanguages(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for language, want := range map[string]string{"en": "No logs yet", "zh": "还没有日志"} {
		var out bytes.Buffer
		if code := Run([]string{"--lang", language, "logs"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), want) {
			t.Errorf("%s: code=%d output=%q", language, code, out.String())
		}
	}
}

func TestLogsRejectsBadArguments(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for _, args := range [][]string{{"logs", "--lines", "0"}, {"logs", "--lines", "-1"}, {"logs", "--component", "../x"}, {"logs", "--component", `a\b`}, {"logs", "extra"}} {
		var out bytes.Buffer
		if code := Run(args, strings.NewReader(""), &out); code != 2 {
			t.Errorf("%v: code=%d", args, code)
		}
	}
}

func TestLogsReportsAFolderItCannotRead(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	if err := os.MkdirAll(filepath.Join(home, "logs", "production"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "logs", "production", "engine"), []byte("not a folder"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := Run([]string{"logs", "--component", "engine"}, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "[MRK-4017]") {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
}

func TestLogsReadsTheLineTheEngineJustWrote(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	cleanupEngine(t, home)
	// Listing sessions starts a real merak serve process, which logs when it starts.
	var out bytes.Buffer
	if code := Run([]string{"session", "list"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("session list=%d %s", code, out.String())
	}
	out.Reset()
	if code := Run([]string{"logs", "--component", "engine"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), "engine starting") {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
	if code := Run([]string{"stop"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("stop=%d", code)
	}
}

func TestFollowLogsPrintsLinesAppendedAfterItStarted(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	writeLog(t, home, "production", "engine", "1-1.ndjson", logLine("10:00:00", "engine", "before follow"))
	selection := logSelection{mode: "production"}
	var out lockedBuffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- followLogs(ctx, &out, selection, 5, 20*time.Millisecond) }()
	waitFor := func(want string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !strings.Contains(out.String(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("never saw %q in %q", want, out.String())
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFor("before follow")
	file := filepath.Join(home, "logs", "production", "engine", "1-1.ndjson")
	appended, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(appended, logLine("10:00:09", "engine", "after follow"))
	appended.Close()
	waitFor("after follow")
	writeLog(t, home, "production", "cli", "2-2.ndjson", logLine("10:00:10", "cli", "new file"))
	waitFor("new file")
	if strings.Count(out.String(), "before follow") != 1 || strings.Count(out.String(), "after follow") != 1 {
		t.Errorf("a line was printed twice:\n%s", out.String())
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("follow ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("follow did not stop when cancelled")
	}
}
