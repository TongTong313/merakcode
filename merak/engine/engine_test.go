package engine_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestChatIncludesProjectInstructionsAndKeepsTheDateOutOfTheSystemPrompt(t *testing.T) {
	for _, instructions := range []string{"Use small focused changes.", ""} {
		dir := t.TempDir()
		if instructions != "" {
			if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(instructions), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		provider := fake.New(t, fake.Reply{Text: "Ready.", Expect: func(req model.Request) error {
			sections := []string{"You are MerakCode", "Role: worker", "Prefer clear names.", "Environment:", dir}
			if instructions != "" {
				sections = append(sections, "Project instructions:", instructions)
			}
			previous := -1
			for _, section := range sections {
				index := strings.Index(req.System, section)
				if index <= previous {
					return fmt.Errorf("system prompt section %q is absent or out of order", section)
				}
				previous = index
			}
			if instructions == "" && strings.Contains(req.System, "Project instructions:") {
				return fmt.Errorf("instructions were invented")
			}
			if strings.Contains(req.System, "2026-11-08") {
				return fmt.Errorf("date entered the frozen system prompt")
			}
			if len(req.Messages) != 1 || len(req.Messages[0].Parts) != 2 || !strings.Contains(req.Messages[0].Parts[0].Text, "2026-11-08T08:00:00Z") || req.Messages[0].Parts[1].Text != "Begin" {
				return fmt.Errorf("opening message lacks the date or user input: %+v", req.Messages)
			}
			return nil
		}})
		e, err := engine.New(engine.Deps{
			Providers: map[string]model.Provider{"fake": provider}, Workdir: dir, System: "Prefer clear names.",
			Now: func() time.Time { return time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC) },
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.Chat(context.Background(), "fake", "Begin"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestChatTellsTheModelWhenWritingIsDenied(t *testing.T) {
	dir := t.TempDir()
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "write-1", Name: "write_file", Input: []byte(`{"path":"result.txt","content":"must not be written"}`)}}},
		fake.Reply{Text: "The write was denied.", Expect: func(req model.Request) error {
			if len(req.Messages) != 3 || len(req.Messages[2].Parts) != 1 {
				return fmt.Errorf("missing denial: %+v", req.Messages)
			}
			result := req.Messages[2].Parts[0].ToolResult
			if result == nil || !result.IsError || result.CallID != "write-1" {
				return fmt.Errorf("model did not see a denied write: %+v", result)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{
		Providers: map[string]model.Provider{"fake": provider}, Workdir: dir,
		Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			return permission.Reply{Decision: permission.Deny}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Chat(context.Background(), "fake", "Write the file"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "result.txt")); !os.IsNotExist(err) {
		t.Fatalf("denied write created a file: %v", err)
	}
}

func TestChatReadsFilesInItsWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("Engine integration fixture."), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "read-1", Name: "read_file", Input: []byte(`{"path":"README.md"}`)}}},
		fake.Reply{Text: "The file was read.", Expect: func(req model.Request) error {
			if len(req.Messages) != 3 || len(req.Messages[2].Parts) != 1 {
				return fmt.Errorf("missing tool result: %+v", req.Messages)
			}
			result := req.Messages[2].Parts[0].ToolResult
			if result == nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != "Engine integration fixture." {
				return fmt.Errorf("read_file was not available: %+v", result)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": provider}, Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := e.Chat(context.Background(), "fake", "Read README.md")
	if err != nil || len(outcome.Final) != 1 || outcome.Final[0].Text != "The file was read." {
		t.Fatalf("outcome = %+v, error = %v", outcome, err)
	}
}

func TestChatChoosesTheFullOrReadOnlyToolPool(t *testing.T) {
	for _, test := range []struct {
		name   string
		tools  []string
		denied bool
	}{
		{"worker.default", []string{"ask_user", "bash", "bash_output", "code_search", "docx_read", "edit_file", "excel_read", "excel_write", "glob", "grep", "list_dir", "lookup", "multi_edit", "read_file", "recall", "remember", "schedule_create", "schedule_delete", "schedule_list", "skill", "spawn", "todo_write", "wait_child", "web_fetch", "web_search", "write_file", "write_plan"}, false},
		{"worker.readonly", []string{"docx_read", "excel_read", "glob", "grep", "list_dir", "lookup", "read_file", "recall", "schedule_list", "skill", "spawn", "todo_write", "wait_child", "write_plan"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			provider := fake.New(t,
				fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: []byte(`{"path":"result.txt","content":"approved"}`)}}, Expect: func(req model.Request) error {
					var names []string
					for _, spec := range req.Tools {
						names = append(names, spec.Name)
					}
					if !reflect.DeepEqual(names, test.tools) {
						return fmt.Errorf("pool tools=%v want=%v", names, test.tools)
					}
					return nil
				}},
				fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
					if req.Messages[2].Parts[0].ToolResult.IsError != test.denied {
						return fmt.Errorf("pool did not enforce tool membership")
					}
					return nil
				}},
			)
			e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": provider}, Workdir: dir, ToolPool: test.name,
				Ask: func(context.Context, permission.Request) (permission.Reply, error) {
					return permission.Reply{Decision: permission.Allow}, nil
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := e.Chat(context.Background(), "fake", "Write the result"); err != nil {
				t.Fatal(err)
			}
			_, err = os.Stat(filepath.Join(dir, "result.txt"))
			if test.denied && !os.IsNotExist(err) || !test.denied && err != nil {
				t.Fatalf("file state=%v", err)
			}
		})
	}
}

func TestChatListsDeferredToolsAndKeepsItsSystemPromptFrozen(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("Deferred read."), 0o600); err != nil {
		t.Fatal(err)
	}
	var system string
	check := func(req model.Request) error {
		if system == "" {
			system = req.System
		}
		if req.System != system || !strings.Contains(system, "Deferred tools:\n- read_file: ") || strings.Contains(system, `"minLength"`) {
			return fmt.Errorf("invalid deferred prompt")
		}
		for _, spec := range req.Tools {
			if spec.Name == "read_file" {
				return fmt.Errorf("deferred tool appeared in provider tools")
			}
		}
		return nil
	}
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: []byte(`{"names":["read_file"]}`)}}, Expect: check},
		fake.Reply{Calls: []model.ToolCall{{ID: "read", Name: "call_tool", Input: []byte(`{"name":"read_file","input":{"path":"notes.txt"}}`)}}, Expect: check},
		fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
			if err := check(req); err != nil {
				return err
			}
			result := req.Messages[len(req.Messages)-1].Parts[0].ToolResult
			if result == nil || result.IsError || result.Parts[0].Text != "Deferred read." {
				return fmt.Errorf("missing deferred read: %+v", result)
			}
			return nil
		}},
	)
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fake": provider}, Workdir: dir, Deferred: []tool.Tool{tool.ReadFile{}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Chat(context.Background(), "fake", "Read notes"); err != nil {
		t.Fatal(err)
	}
}
