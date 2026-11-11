package plugin_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/plugin"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

// writePlugin writes a plugin file into a fresh folder and returns its path.
func writePlugin(t *testing.T, name, code string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(code), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// start runs a host over the plugins with Node from the PATH. The plugin tests need Node, as CI has it installed.
func start(t *testing.T, specs ...string) (*plugin.Host, []plugin.Status) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatalf("the plugin tests need Node.js on the PATH: %v", err)
	}
	dir := t.TempDir()
	var list []plugin.Spec
	for _, spec := range specs {
		list = append(list, plugin.Spec{Spec: spec})
	}
	host, statuses, err := plugin.Start(t.Context(), plugin.Options{Launcher: &sandbox.Launcher{Disabled: true}, Directory: dir, Worktree: dir, DataRoot: t.TempDir(), HookTimeout: time.Second}, list)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { host.Close() })
	return host, statuses
}

const everything = `
export default async (input, options) => ({
  "tool.execute.before": async (info, output) => { output.args.command = "echo hooked" },
  "experimental.chat.messages.transform": async () => {},
  tool: {
    shout: {
      description: "Upper-case a word",
      args: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
      execute: async (args, ctx) => args.word.toUpperCase() + " in " + ctx.directory.length,
    },
  },
})
`

func TestStartLoadsPluginsAndReportsTheirHooksToolsAndIgnoredHooks(t *testing.T) {
	good := writePlugin(t, "good.mjs", everything)
	broken := writePlugin(t, "broken.mjs", "export default async () => {{{ not javascript")
	missing := filepath.Join(t.TempDir(), "missing.mjs")
	_, statuses := start(t, good, broken, missing)
	if len(statuses) != 3 {
		t.Fatalf("statuses = %+v", statuses)
	}
	if got := statuses[0]; got.State != "loaded" || got.ID != "good" || !slices.Equal(got.Hooks, []string{"tool", "tool.execute.before"}) || !slices.Equal(got.Ignored, []string{"experimental.chat.messages.transform"}) || len(got.Tools) != 1 || got.Tools[0].Name != "shout" || got.Tools[0].Description != "Upper-case a word" {
		t.Fatalf("good = %+v", got)
	}
	var schema struct {
		Required []string `json:"required"`
	}
	if err := json.Unmarshal(statuses[0].Tools[0].Schema, &schema); err != nil || !slices.Equal(schema.Required, []string{"word"}) {
		t.Fatalf("the schema of the tool: %s %v", statuses[0].Tools[0].Schema, err)
	}
	for _, failed := range statuses[1:] {
		if failed.State != "failed" || failed.Error == "" {
			t.Fatalf("a plugin that cannot load must be reported as failed: %+v", failed)
		}
	}
}

func TestAHookChangesItsOutputAndAThrowingOrHangingHookFailsAloneWhileTheHostKeepsWorking(t *testing.T) {
	changing := writePlugin(t, "changing.mjs", everything)
	throwing := writePlugin(t, "throwing.mjs", `export default async () => ({ "tool.execute.before": async () => { throw new Error("boom") } })`)
	hanging := writePlugin(t, "hanging.mjs", `export default async () => ({ "tool.execute.before": () => new Promise(() => {}) })`)
	host, _ := start(t, changing, throwing, hanging)
	ctx := context.Background()
	input := map[string]any{"tool": "bash", "sessionID": "s", "callID": "c"}
	output, failures, err := host.Call(ctx, "tool.execute.before", input, json.RawMessage(`{"args":{"command":"ls"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), `"command":"echo hooked"`) {
		t.Fatalf("output = %s", output)
	}
	if len(failures) != 2 || failures[0].Plugin != "throwing" || !strings.Contains(failures[0].Error, "boom") || failures[1].Plugin != "hanging" || !strings.Contains(failures[1].Error, "timed out") {
		t.Fatalf("failures = %+v", failures)
	}
	if again, _, err := host.Call(ctx, "tool.execute.before", input, json.RawMessage(`{"args":{"command":"pwd"}}`)); err != nil || !strings.Contains(string(again), "echo hooked") {
		t.Fatalf("the host stopped working after the failures: %s %v", again, err)
	}
	if untouched, failures, err := host.Call(ctx, "chat.params", input, json.RawMessage(`{"temperature":0.2}`)); err != nil || len(failures) != 0 || string(untouched) != `{"temperature":0.2}` {
		t.Fatalf("a hook nobody has changed the output: %s %v %v", untouched, failures, err)
	}
}

func TestACustomToolRunsInThePluginAndReturnsItsText(t *testing.T) {
	host, _ := start(t, writePlugin(t, "shout.mjs", everything))
	text, err := host.RunTool(context.Background(), "shout", "shout", json.RawMessage(`{"word":"quiet"}`), plugin.ToolContext{Session: "s", Call: "c"})
	if err != nil || !strings.HasPrefix(text, "QUIET in ") {
		t.Fatalf("text = %q, err = %v", text, err)
	}
	if _, err := host.RunTool(context.Background(), "shout", "shout", json.RawMessage(`{}`), plugin.ToolContext{}); err == nil {
		t.Fatal("a tool that throws did not return an error")
	}
	if _, err := host.RunTool(context.Background(), "shout", "nothing", json.RawMessage(`{}`), plugin.ToolContext{}); err == nil {
		t.Fatal("an unknown tool succeeded")
	}
}

func TestWithoutNodeStartFailsWithErrNoNode(t *testing.T) {
	t.Setenv("MERAKCODE_NODE", filepath.Join(t.TempDir(), "no-such-node"))
	dir := t.TempDir()
	_, _, err := plugin.Start(t.Context(), plugin.Options{Launcher: &sandbox.Launcher{Disabled: true}, Directory: dir, Worktree: dir, DataRoot: t.TempDir()}, []plugin.Spec{{Spec: "x.mjs"}})
	if err != plugin.ErrNoNode {
		t.Fatalf("error = %v, want ErrNoNode", err)
	}
}
