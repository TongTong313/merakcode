package codex_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
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
	"testing"
	"time"
)

func TestProductInterruptionRetainsPartialAnswerAndCancelsTheTurn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runner := &codex.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: fakeBinary(t), Env: map[string]string{"MERAKCODE_FIXTURE_MODE": "interrupted"}}}
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
			runner := &codex.Runner{Bus: bus, Gate: gate, Product: profile.Product{Binary: binary}}
			if !runner.Caps().Permission || !runner.Caps().Steer {
				t.Fatal("missing capabilities")
			}
			run, err := runner.Start(ctx, worker.Assignment{Session: "session", Scope: event.Scope{Group: "group", Task: "task"}, Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
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
