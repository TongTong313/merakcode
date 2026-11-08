package claudecode_test

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func fakeBinary(t *testing.T) string {
	t.Helper()
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(t.TempDir(), name)
	command := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakeclaude")
	if body, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, body)
	}
	return binary
}

func TestThinkingAndUnrecognizedBlocksRemainObservable(t *testing.T) {
	for _, tc := range []struct {
		name, line string
		kind       event.Type
		text       string
	}{
		{"thinking delta", `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Checking"}}}`, session.MessageDelta, "Checking"},
		{"thinking block", `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Checked","signature":"signature"}]}}`, session.MessageCompleted, "Checked"},
		{"unknown block", `{"type":"assistant","message":{"content":[{"type":"future_block","data":1}]}}`, "tool.progress", ""},
		{"echoed user", `{"type":"user","message":{"content":"Follow-up"}}`, "tool.progress", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			facts, err := claudecode.Translate([]byte(tc.line), event.Scope{Session: "session"}, event.Actor{Kind: event.ActorAgent})
			if err != nil || len(facts) != 1 || facts[0].Type != tc.kind {
				t.Fatalf("facts=%+v err=%v", facts, err)
			}
			if tc.kind == session.MessageDelta {
				chunk, _ := event.Decode[model.Chunk](facts[0])
				if chunk.Reasoning == nil || chunk.Reasoning.Text != tc.text {
					t.Fatalf("chunk=%+v", chunk)
				}
			}
			if tc.kind == session.MessageCompleted {
				completion, _ := event.Decode[session.Completion](facts[0])
				if len(completion.Parts) != 1 || completion.Parts[0].Reasoning == nil || completion.Parts[0].Reasoning.Text != tc.text {
					t.Fatalf("completion=%+v", completion)
				}
			}
		})
	}
}

func TestTranslatesRecordedProcessLines(t *testing.T) {
	binary := fakeBinary(t)
	fixture, err := filepath.Abs("testdata/conversation.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	cmd := process.Command(context.Background(), t.TempDir(), binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--fixture", fixture)
	cmd.Stdin = strings.NewReader("{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Check README\"}}\n")
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	type view struct {
		Type    event.Type      `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	var got []view
	scope := event.Scope{Session: "session", Task: "task"}
	actor := event.Actor{Kind: event.ActorAgent, ID: "worker"}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		facts, err := claudecode.Translate(scanner.Bytes(), scope, actor)
		if err != nil {
			t.Fatal(err)
		}
		for _, fact := range facts {
			if fact.Scope != scope || fact.Actor != actor || fact.Stream != "session:session" {
				t.Fatalf("lost attribution: %+v", fact)
			}
			got = append(got, view{fact.Type, fact.Payload})
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/translated.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(got)
	var actual, expected any
	if err := json.Unmarshal(body, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("translated events:\n%s\nwant:\n%s", body, want)
	}
}
