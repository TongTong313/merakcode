package pi_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/pi"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLeaderKeepsPendingPromptAcrossEarlierSettledEvent(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	runner := &pi.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: agent.Product{Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "leader-boundary"}}}
	run, err := runner.Start(ctx, worker.Assignment{Leader: true, Session: "leader", Workdir: t.TempDir(), Packet: "First"})
	if err != nil {
		t.Fatal(err)
	}
	defer run.Cancel(context.Background())
	if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Second"}}}); err != nil {
		t.Fatal(err)
	}
	completed := false
	for {
		select {
		case fact := <-run.Events():
			if fact.Type == session.MessageCompleted {
				completed = true
				if fact.Scope.Turn == "" {
					t.Fatal("response lost its turn")
				}
			}
			if fact.Type == loop.TurnFinished && completed {
				return
			}
		case <-ctx.Done():
			t.Fatal("leader did not finish the second prompt")
		}
	}
}

func fakeBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "pi.exe")
	build := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakepi")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	return binary
}

func TestPiPreservesUnicodeSeparatorsAndSharedEvents(t *testing.T) {
	binary := fakeBinary(t)
	fixture, err := filepath.Abs("testdata/conversation.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runner := &pi.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: agent.Product{Binary: binary, Args: []string{"--fixture", fixture}}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "Verified\u2028Unicode" || report.Verdict != task.VerdictDone {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	if report.Usage.Input != 25 || report.Usage.Output != 5 || report.Usage.CacheRead != 3 {
		t.Fatalf("report usage=%+v", report.Usage)
	}
	type record struct {
		Type  event.Type `json:"type"`
		Text  string     `json:"text,omitempty"`
		Name  string     `json:"name,omitempty"`
		Cause int        `json:"cause,omitempty"`
		Input int        `json:"input,omitempty"`
	}
	var actual []record
	indices := map[event.ID]int{}
	for fact := range run.Events() {
		indices[fact.ID] = len(actual) + 1
		item := record{Type: fact.Type, Cause: indices[fact.Cause]}
		switch fact.Type {
		case session.MessageDelta:
			chunk, _ := event.Decode[model.Chunk](fact)
			item.Text = chunk.Text
		case session.MessageCompleted:
			msg, _ := event.Decode[session.Completion](fact)
			item.Input = msg.Usage.Input
			for _, part := range msg.Parts {
				item.Text += part.Text
			}
		case tool.Called:
			call, _ := event.Decode[model.ToolCall](fact)
			item.Name = call.Name
		case tool.Completed:
			done, _ := event.Decode[tool.Completion](fact)
			item.Name = done.Name
		}
		actual = append(actual, item)
	}
	body, err := os.ReadFile("testdata/events.json")
	if err != nil {
		t.Fatal(err)
	}
	var want []record
	if err := json.Unmarshal(body, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("events=%+v want=%+v", actual, want)
	}
}
