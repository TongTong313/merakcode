package acp_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/acp"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestACPVersionOnePermissionsAndGoldenEvents(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "acp.exe")
	build := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakeacp")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			bus := event.NewBus(memory.New(), time.Now, event.NewID)
			asked := 0
			gate := &permission.Gate{Bus: bus, Policy: permission.Policy{Mode: permission.ModeAsk}, Ask: func(_ context.Context, req permission.Request) (permission.Reply, error) {
				asked++
				var input struct{ Command string }
				if err := json.Unmarshal(req.Call.Input, &input); err != nil || input.Command != "verify" {
					t.Errorf("approval lost command input: %s %v", req.Call.Input, err)
				}
				if req.Call.Env.Scope.Task != "task" {
					t.Errorf("scope=%+v", req.Call.Env.Scope)
				}
				return permission.Reply{Decision: decision}, nil
			}}
			runner := &acp.Runner{Bus: bus, Gate: gate, Product: profile.Product{Binary: binary}}
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
			var kinds []event.Type
			for fact := range run.Events() {
				kinds = append(kinds, fact.Type)
			}
			body, err := os.ReadFile("testdata/events.json")
			if err != nil {
				t.Fatal(err)
			}
			var expected []event.Type
			if err := json.Unmarshal(body, &expected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(kinds, expected) {
				t.Fatalf("events=%v", kinds)
			}
		})
	}
}
