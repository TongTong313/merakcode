package tool_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestBashSandboxConfinesForegroundWrites(t *testing.T) {
	checkBashSandboxWrites(t, false)
}

func TestBashSandboxConfinesBackgroundWrites(t *testing.T) {
	checkBashSandboxWrites(t, true)
}

func checkBashSandboxWrites(t *testing.T, background bool) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	jobs := new(tool.Jobs)
	t.Cleanup(jobs.Close)
	env := tool.Env{Workdir: workspace, Jobs: jobs, Sandbox: new(sandbox.Launcher), SandboxProfile: sandbox.Profile{WriteAllow: []string{workspace}}}
	for _, test := range []struct {
		name    string
		path    string
		allowed bool
	}{
		{"writes inside the workspace", filepath.Join(workspace, "allowed.txt"), true},
		{"rejects writes outside the workspace", filepath.Join(root, "denied.txt"), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			input, err := json.Marshal(map[string]any{"command": fmt.Sprintf("printf fixture > %q", test.path), "background": background})
			if err != nil {
				t.Fatal(err)
			}
			result, err := (tool.Bash{}).Run(context.Background(), tool.Call{Input: input, Env: env})
			if background {
				if err != nil || result.JobID == "" {
					t.Fatalf("background launch = %+v, %v", result, err)
				}
				query, _ := json.Marshal(map[string]string{"id": result.JobID})
				deadline := time.Now().Add(5 * time.Second)
				for result.Running && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond)
					result, err = (tool.BashOutput{}).Run(context.Background(), tool.Call{Input: query, Env: env})
					if err != nil {
						t.Fatal(err)
					}
				}
				if result.Running {
					t.Fatal("background command did not finish")
				}
			}
			if err != nil || result.IsError == test.allowed {
				t.Fatalf("bash result = %+v, %v", result, err)
			}
			body, err := os.ReadFile(test.path)
			if test.allowed {
				if err != nil || string(body) != "fixture" {
					t.Fatalf("workspace write = %q, %v", body, err)
				}
				return
			}
			if !os.IsNotExist(err) {
				t.Fatalf("outside file exists or is unreadable: %v", err)
			}
			if result.Code != "MRK-5009" {
				t.Fatalf("unclassified file denial: path=%s result=%+v", test.path, result)
			}
		})
	}
}
