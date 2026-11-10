package claudecode_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestLeaderRecoversInputsNotAcknowledgedByTheProduct(t *testing.T) {
	binary := fakeBinary(t)
	for _, phase := range []string{"initialize-failure", "unacknowledged"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			storage := memory.New()
			runner := &claudecode.Runner{Store: storage, Bus: event.NewBus(storage, time.Now, event.NewID), Product: profile.Product{Binary: binary, Args: []string{"--recovery-phase", phase}}}
			a := worker.Assignment{Leader: true, Session: "recover", Workdir: t.TempDir(), Packet: "Original instruction"}
			run, err := runner.Start(ctx, a)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = run.Wait(ctx); err == nil {
				t.Fatal("fixture should fail before acknowledging input")
			}
			runner.Product.Args = []string{"--recovery-phase", "echo"}
			a.Packet = "Continue after failure"
			run, err = runner.Start(ctx, a)
			if err != nil {
				t.Fatal(err)
			}
			defer run.Cancel(context.Background())
			restored := false
			for {
				select {
				case fact, ok := <-run.Events():
					if !ok {
						_, err := run.Wait(ctx)
						t.Fatalf("recovery stopped: %v", err)
					}
					if fact.Type == session.MessageCompleted {
						completion, _ := event.Decode[session.Completion](fact)
						for _, part := range completion.Parts {
							restored = restored || strings.Contains(part.Text, "Original instruction") && strings.Contains(part.Text, "Continue after failure")
						}
					}
					if fact.Type == loop.TurnFinished {
						if !restored {
							t.Fatal("recovery lost the original instruction")
						}
						return
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}

func TestLeaderErrorResultKeepsFailedOutcome(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	dir := t.TempDir()
	fixture := filepath.Join(dir, "error.jsonl")
	if err := os.WriteFile(fixture, []byte("{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: binary, Args: []string{"--fixture", fixture}}}
	run, err := runner.Start(ctx, worker.Assignment{Leader: true, Session: "leader", Workdir: dir, Packet: "Fail"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err == nil {
		t.Fatal("leader error was lost")
	}
	var finished int
	for fact := range run.Events() {
		if fact.Type != loop.TurnFinished {
			continue
		}
		finished++
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil || outcome.Stop != loop.Failed {
			t.Fatalf("outcome=%+v %v", outcome, err)
		}
	}
	if finished != 1 {
		t.Fatalf("finished=%d", finished)
	}
}

func TestLeaderKeepsUnacknowledgedInputAcrossAnEarlierResult(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	runner := &claudecode.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: fakeBinary(t), Args: []string{"--leader-boundary"}}}
	run, err := runner.Start(ctx, worker.Assignment{Leader: true, Session: "leader", Workdir: t.TempDir(), Packet: "First"})
	if err != nil {
		t.Fatal(err)
	}
	defer run.Cancel(context.Background())
	if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Second"}}}); err != nil {
		t.Fatal(err)
	}
	completed := 0
	inputs := 0
	for {
		select {
		case fact := <-run.Events():
			if fact.Type == session.MessageSent {
				inputs++
				if fact.Scope.Turn == "" {
					t.Fatal("input lost its turn")
				}
			}
			if fact.Type == session.MessageCompleted {
				completed++
				if fact.Scope.Turn == "" {
					t.Fatal("response lost its turn")
				}
			}
			if fact.Type == loop.TurnFinished && completed == 2 {
				if inputs != 2 {
					t.Fatalf("finished before both inputs were recorded: %d", inputs)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("leader did not acknowledge both inputs")
		}
	}
}

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
