package tool_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestBackgroundBashReturnsWhileRunningAndExposesCurrentOutput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	jobs := new(tool.Jobs)
	defer jobs.Close()
	env := tool.Env{Workdir: t.TempDir(), Jobs: jobs}
	input := []byte(`{"command":"printf ready; while [ ! -f release ]; do sleep 0.05; done; printf done; exit 7","background":true}`)
	result, err := (tool.Bash{}).Run(ctx, tool.Call{Input: input, Env: env})
	if err != nil || result.IsError || !result.Running || result.JobID == "" {
		t.Fatalf("start=%+v error=%v", result, err)
	}
	query, err := json.Marshal(map[string]string{"id": result.JobID})
	if err != nil {
		t.Fatal(err)
	}
	poll := func(done bool) tool.Result {
		t.Helper()
		for {
			output, err := (tool.BashOutput{}).Run(ctx, tool.Call{Input: query, Env: env})
			if err != nil {
				t.Fatal(err)
			}
			if len(output.Parts) == 1 && strings.Contains(output.Parts[0].Text, "ready") && output.Running != done {
				return output
			}
			select {
			case <-ctx.Done():
				t.Fatal("background output did not arrive")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	if output := poll(false); output.ExitCode != nil {
		t.Fatalf("running process has exit code: %+v", output)
	}
	if err := os.WriteFile(filepath.Join(env.Workdir, "release"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	output := poll(true)
	if output.Parts[0].Text != "readydone" || !output.IsError || output.ExitCode == nil || *output.ExitCode != 7 {
		t.Fatalf("finished output=%+v", output)
	}
}
