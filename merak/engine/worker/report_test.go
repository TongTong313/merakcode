package worker_test

import (
	"context"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestReportsRejectTrailingContentAndBoundFallbacks(t *testing.T) {
	for _, tc := range []struct {
		name, text  string
		stop        loop.StopReason
		err         error
		synthesized bool
		verdict     task.Verdict
	}{
		{"structured", `{"verdict":"done","summary":"Verified"}`, loop.Answered, nil, false, task.VerdictDone},
		{"missing exit code", `{"verdict":"done","summary":"Verified","checks":[{"command":"go test ./..."}]}`, loop.Answered, nil, true, task.VerdictDone},
		{"null exit code", `{"verdict":"done","summary":"Verified","checks":[{"command":"go test ./...","exitCode":null}]}`, loop.Answered, nil, true, task.VerdictDone},
		{"explicit success", `{"verdict":"done","summary":"Verified","checks":[{"command":"go test ./...","exitCode":0}]}`, loop.Answered, nil, false, task.VerdictDone},
		{"trailing", `{"verdict":"done","summary":"Verified"} false`, loop.Answered, nil, true, task.VerdictDone},
		{"invalid artifact", `{"verdict":"done","summary":"Verified","artifacts":[{"path":"../outside.txt"}]}`, loop.Answered, nil, true, task.VerdictDone},
		{"oversized", strings.Repeat("x", 1300), loop.Answered, nil, true, task.VerdictDone},
		{"cancelled", `{"verdict":"done","summary":"Verified"}`, loop.Cancelled, context.Canceled, true, task.VerdictBlocked},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report := worker.ReportFromText("claim", tc.text, tc.stop, tc.err)
			if report.Synthesized != tc.synthesized || report.Verdict != tc.verdict || report.Claim != "claim" || len([]rune(report.Summary)) > 1200 {
				t.Fatalf("report=%+v", report)
			}
		})
	}
}
