package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type SubmitReport struct {
	Claim  event.ID
	Submit func(context.Context, task.Report) error
}

type ReportProgress struct {
	Report func(context.Context, string) error
}

func (ReportProgress) Spec() Spec {
	return Spec{Name: "report_progress", Description: "Report one short line of progress on the assigned task. This does not finish the task.", Effect: EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"summary":{"type":"string","minLength":1,"maxLength":300}},"required":["summary"],"additionalProperties":false}`)}
}
func (t ReportProgress) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Summary string `json:"summary"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if t.Report == nil || strings.TrimSpace(input.Summary) == "" || strings.ContainsAny(input.Summary, "\r\n") || len([]rune(input.Summary)) > 300 {
		return failure(errors.New("progress requires one line within 300 characters and an active claim")), nil
	}
	if err := t.Report(ctx, input.Summary); err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "Progress recorded."}}}, nil
}

func (SubmitReport) Spec() Spec {
	return Spec{Name: "submit_report", Description: "Finish the assigned task with a verdict, a summary within 1200 characters, changed files, checks, artifacts, open questions and suggested next steps. Details remain in the session history.", Effect: EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"verdict":{"type":"string","enum":["done","blocked","needs_review","failed"]},"summary":{"type":"string","minLength":1,"maxLength":1200},"changes":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"kind":{"type":"string"},"added":{"type":"integer","minimum":0},"removed":{"type":"integer","minimum":0}},"required":["path","kind","added","removed"],"additionalProperties":false}},"checks":{"type":"array","items":{"type":"object","properties":{"command":{"type":"string"},"exitCode":{"type":"integer"}},"required":["command","exitCode"],"additionalProperties":false}},"questions":{"type":"array","items":{"type":"string"},"maxItems":5},"next":{"type":"array","items":{"type":"string"},"maxItems":5},"artifacts":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"title":{"type":"string"},"mediaType":{"type":"string"}},"required":["path"],"additionalProperties":false}}},"required":["verdict","summary"],"additionalProperties":false}`)}
}
func (t SubmitReport) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Verdict   task.Verdict      `json:"verdict"`
		Summary   string            `json:"summary"`
		Artifacts []task.Artifact   `json:"artifacts"`
		Changes   []task.FileChange `json:"changes"`
		Checks    []task.Check      `json:"checks"`
		Questions []string          `json:"questions"`
		Next      []string          `json:"next"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if t.Claim == "" || t.Submit == nil {
		return failure(errors.New("reports require an active task claim")), nil
	}
	report := task.Report{Claim: t.Claim, Verdict: input.Verdict, Summary: input.Summary, Artifacts: input.Artifacts, Changes: input.Changes, Checks: input.Checks, Questions: input.Questions, Next: input.Next}
	if err := report.Validate(); err != nil {
		return failure(err), nil
	}
	if err := t.Submit(ctx, report); err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "Report accepted."}}}, nil
}
