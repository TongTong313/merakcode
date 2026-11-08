package command_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
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
	"github.com/TongTong313/merakcode/merak/engine/worker/command"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestCommandStreamsOutputAndAlwaysSynthesizesItsReport(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "command.exe")
	build := process.Command(context.Background(), "", "go", "build", "-o", binary, "./testdata/fakecommand")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dir := t.TempDir()
	runner := &command.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Product: profile.Product{Binary: binary}}
	if runner.Caps().Steer || runner.Caps().Permission {
		t.Fatal("command advertised unsupported capabilities")
	}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: dir, Packet: "Inspect", Claim: task.Claim{ID: "claim", Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Send(ctx, loop.Input{Parts: []model.Part{{Text: "Follow-up"}}}); !errors.Is(err, worker.ErrUnsupported) {
		t.Fatalf("send=%v", err)
	}
	report, err := run.Wait(ctx)
	if err != nil || !report.Synthesized || report.Verdict != task.VerdictDone || report.Summary != "{\"verdict\":\"done\",\"summary\":\"Inspected\"}" {
		t.Fatalf("report=%+v err=%v", report, err)
	}
	input, err := os.ReadFile(filepath.Join(dir, "input.txt"))
	if err != nil || string(input) != "Inspect" {
		t.Fatalf("input=%q err=%v", input, err)
	}
	var kinds []event.Type
	var text string
	for fact := range run.Events() {
		if fact.Type == session.MessageDelta {
			chunk, _ := event.Decode[model.Chunk](fact)
			text += chunk.Text
			continue
		}
		kinds = append(kinds, fact.Type)
	}
	if !reflect.DeepEqual(kinds, []event.Type{"session.created", "turn.started", "message.sent", "message.completed", "turn.finished"}) || text != report.Summary {
		t.Fatalf("events=%v text=%q", kinds, text)
	}
}
