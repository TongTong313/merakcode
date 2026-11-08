package tool_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestBashReportsOutputExitCodeAndTimeout(t *testing.T) {
	for _, test := range []struct {
		name, command, output string
		timeout               time.Duration
		exit                  int
		failed                bool
	}{
		{"captures output", "printf 'hello from bash'", "hello from bash", 5 * time.Second, 0, false},
		{"reports a nonzero exit", "printf 'failure detail' >&2; exit 7", "failure detail", 5 * time.Second, 7, true},
		{"kills a timed out command", "sleep 20", "", 500 * time.Millisecond, -1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), test.timeout)
			defer cancel()
			input, err := json.Marshal(map[string]string{"command": test.command})
			if err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			result, err := (tool.Bash{}).Run(ctx, tool.Call{Input: input, Env: tool.Env{Workdir: t.TempDir()}})
			if err != nil || result.IsError != test.failed || result.ExitCode == nil || *result.ExitCode != test.exit {
				t.Fatalf("result=%+v error=%v", result, err)
			}
			if len(result.Parts) != 1 || !strings.Contains(result.Parts[0].Text, test.output) {
				t.Fatalf("output=%+v", result.Parts)
			}
			if time.Since(started) > 4*time.Second {
				t.Fatal("timed out command did not stop promptly")
			}
		})
	}
}
