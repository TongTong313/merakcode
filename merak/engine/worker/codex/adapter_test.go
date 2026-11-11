package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/codex"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLeaderRecoversInputBeforeNativeAcknowledgement(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	storage := memory.New()
	runner := &codex.Runner{Store: storage, Bus: event.NewBus(storage, time.Now, event.NewID), Product: agent.Product{Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "recovery-fail"}}}
	a := worker.Assignment{Leader: true, Session: "recover", Workdir: t.TempDir(), Packet: "Original instruction"}
	run, err := runner.Start(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = run.Wait(ctx); err == nil {
		t.Fatal("fixture should fail before acknowledging input")
	}
	initial, _ := storage.Read(ctx, "session:recover", 1, 0)
	sent := false
	for _, fact := range initial {
		sent = sent || fact.Type == session.MessageSent
	}
	if !sent {
		t.Fatalf("fixture failed before receiving input: %v events=%+v", err, initial)
	}
	runner.Product.Env["MERAKCODE_FIXTURE_MODE"] = "recovery-echo"
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
					t.Fatal("recovery lost unacknowledged input")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestLeaderRetriesInputRejectedAfterThePreviousTurnCompleted(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	directory := t.TempDir()
	boundary := filepath.Join(directory, "continue")
	turn := worker.NewLeaderTurn()
	runner := &codex.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: agent.Product{Binary: fakeBinary(t), Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "leader-boundary", "MERAKCODE_FIXTURE_BOUNDARY_WAIT": boundary}}}
	run, err := runner.Start(ctx, worker.Assignment{Leader: true, LeaderTurn: turn, Session: "leader", Workdir: directory, Packet: "First"})
	if err != nil {
		t.Fatal(err)
	}
	defer run.Cancel(context.Background())
	if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Second"}}, Cause: "cause"}); err != nil {
		t.Fatal(err)
	}
	completed, inputs := false, 0
	for {
		select {
		case fact, ok := <-run.Events():
			if !ok {
				_, err := run.Wait(ctx)
				t.Fatalf("leader stopped: %v", err)
			}
			if fact.Type == session.MessageSent {
				inputs++
				if inputs == 2 && fact.Cause != "cause" {
					t.Fatal("lost input cause")
				}
				if inputs == 2 {
					turn.Finish("Finished old turn")
					if err := os.WriteFile(boundary, nil, 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if fact.Type == session.MessageCompleted {
				completed = true
				release, err := turn.Enter(ctx)
				if err != nil {
					t.Fatalf("retry did not reopen orchestration: %v", err)
				}
				release()
				if err := os.WriteFile(boundary+".second", nil, 0600); err != nil {
					t.Fatal(err)
				}
				if fact.Scope.Turn == "" {
					t.Fatal("response lost its turn")
				}
			}
			if fact.Type == loop.TurnFinished {
				if !completed {
					t.Fatal("finished the batch before retrying its pending input")
				}
				if inputs != 2 {
					t.Fatalf("inputs=%d", inputs)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("leader lost the rejected input")
		}
	}
}

func TestProductInterruptionRetainsPartialAnswerAndCancelsTheTurn(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runner := &codex.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: agent.Product{Binary: binary, Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "interrupted"}}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if !errors.Is(err, context.Canceled) || report.Verdict != task.VerdictBlocked || report.Summary != "Partial answer" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	var stopped loop.StopReason
	for fact := range run.Events() {
		if fact.Type == loop.TurnFinished {
			outcome, decodeErr := event.Decode[loop.Outcome](fact)
			if decodeErr != nil {
				t.Fatal(decodeErr)
			}
			stopped = outcome.Stop
		}
	}
	if stopped != loop.Cancelled {
		t.Fatalf("stop=%s", stopped)
	}
}

func fakeBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "codex.exe")
	cmd := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakecodex")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	return binary
}

func TestCodexPermissionModeControlsNewAndResumedProductThreads(t *testing.T) {
	binary := fakeBinary(t)
	for _, tc := range []struct {
		name, sandbox, approval string
		mode                    permission.Mode
		readOnly                bool
	}{
		{"takeover", "danger-full-access", "never", permission.ModeTakeover, false},
		{"ask", "workspace-write", "untrusted", permission.ModeAsk, false},
		{"read only takeover", "read-only", "never", permission.ModeTakeover, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			storage := memory.New()
			runner := &codex.Runner{Bus: event.NewBus(storage, time.Now, event.NewID), Store: storage,
				Product: agent.Product{Binary: binary, Env: map[string]string{
					"MERAKCODE_FIXTURE_MODE": "history", "MERAKCODE_FIXTURE_SANDBOX": tc.sandbox,
					"MERAKCODE_FIXTURE_APPROVAL": tc.approval,
				}}}
			assignment := worker.Assignment{Session: "session", Workdir: t.TempDir(), Mode: tc.mode, ReadOnly: tc.readOnly}
			for _, packet := range []string{"Original brief", "Continue"} {
				assignment.Packet = packet
				run, err := runner.Start(ctx, assignment)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := run.Wait(ctx); err != nil {
					t.Fatalf("packet=%q policy=%s sandbox=%s: %v", packet, tc.approval, tc.sandbox, err)
				}
			}
		})
	}
}

func TestCodexRoutesApprovalsAndEmitsSharedEvents(t *testing.T) {
	binary := fakeBinary(t)
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			asked := 0
			gate := &permission.Gate{Bus: bus, Policy: permission.Policy{Mode: permission.ModeAsk}, Ask: func(_ context.Context, req permission.Request) (permission.Reply, error) {
				asked++
				if req.Call.Env.Scope.Group != "group" || req.Call.Env.Scope.Task != "task" || req.Call.Env.Scope.Session != "session" {
					t.Errorf("approval scope=%+v", req.Call.Env.Scope)
				}
				return permission.Reply{Decision: decision}, nil
			}}
			runner := &codex.Runner{Bus: bus, Gate: gate, Product: agent.Product{Binary: binary}}
			if !runner.Caps().Permission || !runner.Caps().Steer {
				t.Fatal("missing capabilities")
			}
			run, err := runner.Start(ctx, worker.Assignment{Mode: permission.ModeAsk, Session: "session", Scope: event.Scope{Group: "group", Task: "task"}, Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			want := "Approved"
			if decision == permission.Deny {
				want = "Denied"
			}
			if err != nil || report.Summary != want || asked != 1 {
				t.Fatalf("report=%+v err=%v asked=%d", report, err, asked)
			}
			var actual []event.Type
			var callID, requestID event.ID
			for fact := range run.Events() {
				actual = append(actual, fact.Type)
				if fact.Type == session.Created {
					state, err := event.Decode[session.State](fact)
					if err != nil || state.Config.Mode != permission.ModeAsk {
						t.Fatalf("session mode=%q error=%v", state.Config.Mode, err)
					}
				}
				if fact.Type == tool.Called {
					callID = fact.ID
				}
				if fact.Type == permission.Requested {
					requestID = fact.ID
				}
				if fact.Type == tool.Completed && fact.Cause != callID {
					t.Fatalf("tool cause=%s", fact.Cause)
				}
				if fact.Type == permission.Replied && fact.Cause != requestID {
					t.Fatalf("reply cause=%s", fact.Cause)
				}
				if fact.Type == session.MessageCompleted {
					msg, _ := event.Decode[session.Completion](fact)
					if msg.Parts[0].Text != want {
						t.Fatalf("message=%+v", msg)
					}
				}
			}
			body, err := os.ReadFile("testdata/events.json")
			if err != nil {
				t.Fatal(err)
			}
			var expected []event.Type
			if err := json.Unmarshal(body, &expected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("events=%v", actual)
			}
		})
	}
}
