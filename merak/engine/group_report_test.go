package engine_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestStructuredWorkerReportRetainsReviewFields(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	input := json.RawMessage(`{"verdict":"done","summary":"Updated the API documentation and checked the examples.","changes":[{"path":"README.md","kind":"modified","added":2,"removed":1}],"checks":[{"command":"go test ./...","exitCode":0}],"questions":["Confirm the naming?"],"next":["Publish the examples."]}`)
	usage := model.Usage{Input: 17, Output: 9, CacheRead: 4}
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: input}}, Usage: &usage}, fake.Reply{Text: "Report rejected."}, fake.Reply{Text: "No accepted report."})
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Model.Provider = "fake"
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Workdir: dir, Claim: task.Claim{ID: "claim", Task: "task", Member: "worker"}, Packet: "Update the documentation and return its structured report."})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if report.Synthesized {
		t.Fatalf("structured report was replaced by free text: %+v", report)
	}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var actual, expected map[string]any
	if err := json.Unmarshal(body, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(input, &expected); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"changes", "checks", "questions", "next"} {
		if !reflect.DeepEqual(actual[key], expected[key]) {
			t.Errorf("%s=%v want %v", key, actual[key], expected[key])
		}
	}
	if !reflect.DeepEqual(actual["usage"], map[string]any{"input": float64(17), "output": float64(9), "cacheRead": float64(4), "cacheWrite": float64(0), "cost": float64(0), "costKnown": false}) {
		t.Errorf("report usage=%v", actual["usage"])
	}
}

func TestSynthesizedWorkerReportCountsBothAttempts(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	provider := fake.New(t,
		fake.Reply{Text: "First unstructured answer.", Usage: &model.Usage{Input: 13, Output: 7}},
		fake.Reply{Text: "Second unstructured answer.", Usage: &model.Usage{Input: 29, Output: 11}},
	)
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Model.Provider = "fake"
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: event.NewID(), Workdir: dir, Claim: task.Claim{ID: "claim", Task: "task", Member: "worker"}, Packet: "Complete the assignment."})
	if err != nil {
		t.Fatal(err)
	}
	report, err := run.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Synthesized || report.Usage.Input != 42 || report.Usage.Output != 18 {
		t.Fatalf("report=%+v", report)
	}
}
