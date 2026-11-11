package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/plugin"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func pluginFile(t *testing.T, name, code string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(code), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// pluginEngine is an engine with the plugins configured and every permission granted.
func pluginEngine(t *testing.T, provider model.Provider, files ...string) *engine.Engine {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), DataDir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider},
		Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			return permission.Reply{Decision: permission.Allow}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	var specs []plugin.Spec
	for _, file := range files {
		specs = append(specs, plugin.Spec{Spec: file})
	}
	e.ConfigurePlugins(specs)
	return e
}

func lastToolText(req model.Request) string {
	texts, _ := toolResultsOf(req)
	if len(texts) == 0 {
		return ""
	}
	return texts[len(texts)-1]
}

func pluginFailures(t *testing.T, e *engine.Engine) []plugin.FailedEvent {
	t.Helper()
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{plugin.Failed}})
	if err != nil {
		t.Fatal(err)
	}
	var failures []plugin.FailedEvent
	for _, fact := range facts {
		failure, err := event.Decode[plugin.FailedEvent](fact)
		if err != nil {
			t.Fatal(err)
		}
		failures = append(failures, failure)
	}
	return failures
}

func TestAPluginChangesTheArgumentsAndTheResultOfATool(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	file := pluginFile(t, "rewrite.mjs", `
export default async () => ({
  "tool.execute.before": async (info, output) => { if (info.tool === "bash") output.args.command = "echo hooked" },
  "tool.execute.after": async (info, output) => { if (info.tool === "bash") output.output = output.output.trim() + " (checked by a plugin)" },
})`)
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "run", Name: "bash", Input: []byte(`{"command":"echo original"}`)}}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			if text := lastToolText(req); !strings.Contains(text, "hooked") || strings.Contains(text, "original") || !strings.HasSuffix(text, "(checked by a plugin)") {
				return fmt.Errorf("the model saw %q", text)
			}
			return nil
		}},
	)
	e := pluginEngine(t, provider, file)
	if _, err := e.Chat(ctx, "fake", "Run it"); err != nil {
		t.Fatal(err)
	}
}

func TestACustomToolOfAPluginIsDeferredAndGatedAndReturnsWhatThePluginSays(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	file := pluginFile(t, "shout.mjs", `
export default async () => ({
  tool: { shout: { description: "Upper-case a word", args: { type: "object", properties: { word: { type: "string" } }, required: ["word"] }, execute: async (args) => args.word.toUpperCase() } },
})`)
	var asked []string
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: []byte(`{"names":["plugin__shout__shout"]}`)}}, Expect: func(req model.Request) error {
			if !strings.Contains(req.System, "plugin__shout__shout") {
				return fmt.Errorf("the plugin tool is not listed as a deferred tool")
			}
			return nil
		}},
		fake.Reply{Calls: []model.ToolCall{{ID: "call", Name: "call_tool", Input: []byte(`{"name":"plugin__shout__shout","input":{"word":"quiet"}}`)}}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			if text := lastToolText(req); text != "QUIET" {
				return fmt.Errorf("the model saw %q", text)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), DataDir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider},
		Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
			asked = append(asked, request.Spec.Name)
			return permission.Reply{Decision: permission.Allow}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigurePlugins([]plugin.Spec{{Spec: file}})
	if _, err := e.Chat(ctx, "fake", "Shout"); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(asked) != "[plugin__shout__shout]" {
		t.Fatalf("permission asked for %v, want the plugin tool once", asked)
	}
}

func TestAHookThatThrowsOrHangsLeavesTheTurnIntactAndEmitsPluginFailed(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	throwing := pluginFile(t, "throwing.mjs", `export default async () => ({ "tool.execute.before": async () => { throw new Error("boom") } })`)
	hanging := pluginFile(t, "hanging.mjs", `export default async () => ({ "tool.execute.before": () => new Promise(() => {}) })`)
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "run", Name: "bash", Input: []byte(`{"command":"echo untouched"}`)}}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			if text := lastToolText(req); !strings.Contains(text, "untouched") {
				return fmt.Errorf("the tool did not run: %q", text)
			}
			return nil
		}},
	)
	e := pluginEngine(t, provider, throwing, hanging)
	e.SetPluginHookTimeout(500 * time.Millisecond)
	if _, err := e.Chat(ctx, "fake", "Run it"); err != nil {
		t.Fatal(err)
	}
	failures := pluginFailures(t, e)
	if len(failures) != 2 || failures[0].Plugin != "throwing" || failures[0].Hook != "tool.execute.before" || !strings.Contains(failures[0].Error, "boom") || failures[1].Plugin != "hanging" || !strings.Contains(failures[1].Error, "timed out") {
		t.Fatalf("failures = %+v", failures)
	}
}

func TestWithoutNodeAConversationRunsNormallyAndPluginListSaysNodeIsNeeded(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	t.Setenv("MERAKCODE_NODE", filepath.Join(t.TempDir(), "no-such-node"))
	file := pluginFile(t, "rewrite.mjs", `export default async () => ({ "tool.execute.before": async (i, o) => { o.args.command = "echo hooked" } })`)
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "run", Name: "bash", Input: []byte(`{"command":"echo original"}`)}}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			if text := lastToolText(req); !strings.Contains(text, "original") {
				return fmt.Errorf("the model saw %q", text)
			}
			return nil
		}},
	)
	e := pluginEngine(t, provider, file)
	if _, err := e.Chat(ctx, "fake", "Run it"); err != nil {
		t.Fatal(err)
	}
	listed, err := e.ListPlugins(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].State != "failed" || listed[0].Code != "MRK-3003" || listed[0].Spec != file {
		t.Fatalf("listed = %+v", listed)
	}
	body, _ := json.Marshal(listed)
	if !strings.Contains(string(body), "MRK-3003") {
		t.Fatalf("listed = %s", body)
	}
}

func TestAPluginChangesTheSamplingParametersTheMessageAndTheToolDescriptions(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	file := pluginFile(t, "shape.mjs", `
export default async () => ({
  "chat.params": async (info, output) => { output.temperature = 0.3; output.topP = 0.8 },
  "chat.message": async (info, output) => { output.parts[0].text += " [reviewed]" },
  "tool.definition": async (info, output) => { if (info.toolID === "read_file") output.description = "Read a file (plugin note)" },
})`)
	provider := fake.New(t, fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
		if req.Temperature == nil || *req.Temperature != 0.3 || req.TopP == nil || *req.TopP != 0.8 {
			return fmt.Errorf("sampling = %v %v", req.Temperature, req.TopP)
		}
		var description string
		for _, spec := range req.Tools {
			if spec.Name == "read_file" {
				description = spec.Description
			}
		}
		if description != "Read a file (plugin note)" {
			return fmt.Errorf("read_file is described as %q", description)
		}
		var texts []string
		for _, message := range req.Messages {
			for _, part := range message.Parts {
				texts = append(texts, part.Text)
			}
		}
		if !strings.Contains(strings.Join(texts, "\n"), "Hello [reviewed]") {
			return fmt.Errorf("the message the model saw: %q", texts)
		}
		return nil
	}})
	e := pluginEngine(t, provider, file)
	if _, err := e.Chat(ctx, "fake", "Hello"); err != nil {
		t.Fatal(err)
	}
}

func TestAPluginDecidesPermissionsAddsShellVariablesAndSeesEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	marker := filepath.Join(t.TempDir(), "events.txt")
	file := pluginFile(t, "govern.mjs", fmt.Sprintf(`
import fs from "node:fs"
export default async () => ({
  "permission.ask": async (info, output) => { output.status = JSON.stringify(info).includes("forbidden") ? "deny" : "allow" },
  "shell.env": async (info, output) => { output.env.FROM_PLUGIN = "yes" },
  event: async ({ event }) => { if (event.type === "turn.finished") fs.writeFileSync(%q, "seen") },
})`, marker))
	var asked int
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "env", Name: "bash", Input: []byte(`{"command":"echo value=$FROM_PLUGIN"}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "no", Name: "bash", Input: []byte(`{"command":"echo forbidden"}`)}}, Expect: func(req model.Request) error {
			if text := lastToolText(req); !strings.Contains(text, "value=yes") {
				return fmt.Errorf("the shell did not get the variable: %q", text)
			}
			return nil
		}},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			texts, failed := toolResultsOf(req)
			if len(texts) != 2 || !failed[1] || !strings.Contains(texts[1], "denied") {
				return fmt.Errorf("the plugin's denial did not reach the model: %q %v", texts, failed)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), DataDir: t.TempDir(), Providers: map[string]model.Provider{"fake": provider},
		Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			asked++
			return permission.Reply{Decision: permission.Allow}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.ConfigurePlugins([]plugin.Spec{{Spec: file}})
	if _, err := e.Chat(ctx, "fake", "Run it"); err != nil {
		t.Fatal(err)
	}
	if asked != 0 {
		t.Fatalf("a person was asked %d times although the plugin decided", asked)
	}
	waitFor(t, ctx, "the event hook", func() bool { _, err := os.Stat(marker); return err == nil })
}
