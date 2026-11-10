package task_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestReportRejectsCredentialsInEveryTextField(t *testing.T) {
	credential := "sk-abcdefghijklmnopqrstuvwxyz0123456789"
	for _, tc := range []struct {
		name   string
		report task.Report
	}{
		{"summary", task.Report{Summary: credential}},
		{"question", task.Report{Summary: "Checked", Questions: []string{credential}}},
		{"next step", task.Report{Summary: "Checked", Next: []string{credential}}},
		{"command", task.Report{Summary: "Checked", Checks: []task.Check{{Command: "curl -H 'Bearer " + credential + "'"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.report.Verdict = task.VerdictDone
			if err := tc.report.Validate(); err == nil {
				t.Fatal("credential-bearing report was accepted")
			}
		})
	}
}
