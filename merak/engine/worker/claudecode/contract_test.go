package claudecode_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/builtin"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
)

func TestRunnersShareDurableEventTypesAndCauses(t *testing.T) {
	binary := fakeBinary(t)
	fixture, err := filepath.Abs("testdata/conversation.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []worker.Kind{worker.KindBuiltin, worker.KindClaudeCode} {
		t.Run(string(kind), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("README content"), 0600); err != nil {
				t.Fatal(err)
			}
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			var runner worker.Runner = &claudecode.Runner{Bus: bus, Product: profile.Product{Kind: kind, Binary: binary, Args: []string{"--fixture", fixture}}}
			if kind == worker.KindBuiltin {
				provider := fake.New(t, fake.Reply{Text: "Checking", Calls: []model.ToolCall{{ID: "call-1", Name: "read_file", Input: []byte(`{"path":"README.md"}`)}}}, fake.Reply{Text: "Checked README."})
				runner = &builtin.Adapter{Bus: bus, Execute: func(ctx context.Context, assignment worker.Assignment, steer loop.Steer) (loop.Outcome, error) {
					state, err := session.NewManager(storage, bus).Create(ctx, session.State{ID: assignment.Session})
					if err != nil {
						return loop.Outcome{}, err
					}
					l := loop.Loop{Bus: bus, Model: provider, Tools: tool.NewPool("worker.readonly"), Env: tool.Env{Workdir: assignment.Workdir}, Steer: steer}
					return l.RunTurn(ctx, state, loop.Input{Parts: []model.Part{{Text: assignment.Packet}}, Cause: assignment.Cause})
				}}
			}
			assignment := worker.Assignment{Session: "session", Claim: task.Claim{ID: "claim", Member: "member"}, Workdir: dir, Packet: "Check README"}
			run, err := runner.Start(ctx, assignment)
			if err != nil {
				t.Fatal(err)
			}
			report, err := run.Wait(ctx)
			if err != nil || report.Verdict != task.VerdictDone || report.Summary != "Checked README." || !report.Synthesized || report.Claim != "claim" {
				t.Fatalf("report=%+v err=%v", report, err)
			}
			var types []event.Type
			var causes []int
			indices := map[event.ID]int{}
			for fact := range run.Events() {
				if event.Transient(fact.Type) {
					continue
				}
				indices[fact.ID] = len(types) + 1
				types = append(types, fact.Type)
				if fact.Cause != "" && indices[fact.Cause] == 0 {
					t.Fatalf("unknown cause: %+v", fact)
				}
				causes = append(causes, indices[fact.Cause])
			}
			want := []event.Type{"session.created", "turn.started", "message.sent", "message.completed", "tool.called", "tool.completed", "message.completed", "turn.finished"}
			if !reflect.DeepEqual(types, want) || !reflect.DeepEqual(causes, []int{0, 0, 0, 0, 0, 5, 0, 0}) {
				t.Fatalf("types=%v causes=%v", types, causes)
			}
		})
	}
}
