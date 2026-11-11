package opencode_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/opencode"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestOpenCodeStartsACPWithEngineApprovalPolicy(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "opencode.exe")
	build := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakeopencode")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	bus := event.NewBus(memory.New(), time.Now, event.NewID)
	asked := 0
	gate := &permission.Gate{Bus: bus, Policy: permission.Policy{Mode: permission.ModeAsk}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		asked++
		return permission.Reply{Decision: permission.Deny}, nil
	}}
	config := map[string]string{"OPENCODE_CONFIG_CONTENT": `{"permission":"allow","model":"local/test"}`}
	runner := &opencode.Runner{Bus: bus, Gate: gate, Product: agent.Product{Binary: binary, Env: config}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: t.TempDir(), Packet: "Verify", Claim: task.Claim{ID: "claim", Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil || report.Summary != "Denied" || asked != 1 {
		t.Fatalf("report=%+v err=%v asked=%d", report, err, asked)
	}
	if config["OPENCODE_CONFIG_CONTENT"] != `{"permission":"allow","model":"local/test"}` {
		t.Fatal("caller configuration was mutated")
	}
	var kinds []event.Type
	for fact := range run.Events() {
		kinds = append(kinds, fact.Type)
	}
	body, err := os.ReadFile("testdata/events.json")
	if err != nil {
		t.Fatal(err)
	}
	var want []event.Type
	if err := json.Unmarshal(body, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("events=%v", kinds)
	}
}
