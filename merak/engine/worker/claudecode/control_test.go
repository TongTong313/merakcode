package claudecode_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
)

func TestExternalWorkerReceivesSteeringAndCancelsAWaitingProcess(t *testing.T) {
	binary := fakeBinary(t)
	for _, cancelRun := range []bool{false, true} {
		name := "steer"
		if cancelRun {
			name = "cancel"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			dir := t.TempDir()
			fixture := filepath.Join(dir, "reply.jsonl")
			if err := os.WriteFile(fixture, []byte("{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":{\"verdict\":\"done\",\"summary\":\"Follow-up verified\"}}\n"), 0600); err != nil {
				t.Fatal(err)
			}
			runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: binary, Args: []string{"--fixture", fixture, "--hold"}}}
			if !runner.Caps().Steer {
				t.Fatal("steering was not advertised")
			}
			run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: dir, Packet: "Original", Claim: task.Claim{ID: "claim"}})
			if err != nil {
				t.Fatal(err)
			}
			for {
				if _, err := os.Stat(filepath.Join(dir, "inputs.json")); err == nil {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if cancelRun {
				if err := run.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
				report, err := run.Wait(ctx)
				if !errors.Is(err, context.Canceled) || report.Verdict != task.VerdictBlocked || !report.Synthesized {
					t.Fatalf("report=%+v err=%v", report, err)
				}
				return
			}
			if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Follow-up"}}}); err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Synthesized || report.Summary != "Follow-up verified" || report.Claim != "claim" {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			body, err := os.ReadFile(filepath.Join(dir, "inputs.json"))
			if err != nil {
				t.Fatal(err)
			}
			var inputs []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			}
			if err := json.Unmarshal(body, &inputs); err != nil {
				t.Fatal(err)
			}
			if len(inputs) != 2 || inputs[0].Message.Content != "Original" || inputs[1].Message.Content != "Follow-up" {
				t.Fatalf("input ordering=%s", body)
			}
		})
	}
}

func TestRepeatedAssistantUsageIsCountedOncePerMessage(t *testing.T) {
	binary := fakeBinary(t)
	dir := t.TempDir()
	fixture := filepath.Join(dir, "usage.jsonl")
	body := `{"type":"assistant","message":{"id":"message-1","content":[{"type":"text","text":"First"}],"usage":{"input_tokens":10,"output_tokens":1}}}
{"type":"assistant","message":{"id":"message-1","content":[{"type":"text","text":"Second"}],"usage":{"input_tokens":10,"output_tokens":2}}}
{"type":"result","subtype":"success","result":"Finished"}
`
	if err := os.WriteFile(fixture, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: binary, Args: []string{"--fixture", fixture}}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: dir, Packet: "Check"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var usage model.Usage
	for fact := range run.Events() {
		if fact.Type != session.MessageCompleted {
			continue
		}
		completion, err := event.Decode[session.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		usage = usage.Add(completion.Usage)
	}
	if usage.Input != 10 || usage.Output != 2 {
		t.Fatalf("usage=%+v", usage)
	}
	if report.Usage.Input != 10 || report.Usage.Output != 2 {
		t.Fatalf("report usage=%+v", report.Usage)
	}
}

func TestUnknownOutputIsPreservedAsProgress(t *testing.T) {
	line := []byte(`{"type":"future-event","details":{"progress":3}}`)
	facts, err := claudecode.Translate(line, event.Scope{Session: "session"}, event.Actor{Kind: event.ActorAgent})
	if err != nil || len(facts) != 1 || facts[0].Type != "tool.progress" {
		t.Fatalf("facts=%+v err=%v", facts, err)
	}
	var payload struct {
		Raw json.RawMessage `json:"raw"`
	}
	if err := json.Unmarshal(facts[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if string(payload.Raw) != string(line) {
		t.Fatalf("raw=%s", payload.Raw)
	}
}
