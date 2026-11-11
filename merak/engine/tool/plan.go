package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// WritePlan stores the plan of the conversation and ends the turn, so that the person can review the plan before
// anything is done. It changes no project file and runs nothing, so every permission mode may use it.
type WritePlan struct {
	// Write stores the plan.
	Write func(ctx context.Context, content string) error
}

func (WritePlan) Spec() Spec {
	return Spec{Name: "write_plan", Description: "Write the plan as Markdown: ordered steps, what each changes, how it is checked. The person reviews it and this turn ends; nothing is done until they approve. Use it when asked for a plan or when the work is large.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"content":{"type":"string","minLength":1}},"required":["content"],"additionalProperties":false}`)}
}

func (p WritePlan) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Content string `json:"content"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if strings.TrimSpace(input.Content) == "" {
		return failure(errors.New("a plan needs content")), nil
	}
	if p.Write == nil {
		return failure(errors.New("this conversation cannot hold a plan")), nil
	}
	if err := p.Write(ctx, input.Content); err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "The plan was saved for review. Stop here; do not continue the work until the person approves the plan."}}}, nil
}
