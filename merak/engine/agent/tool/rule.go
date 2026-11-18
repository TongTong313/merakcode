package tool

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
)

// Rule lets the model read a project rule that is listed by name and description.
type Rule struct {
	// Lookup returns the body of a described rule.
	Lookup func(name string) (string, bool)
}

func (Rule) Spec() Spec {
	return Spec{Name: "rule", Description: "Read one of the project rules listed in the system prompt by its name, when it applies to your work.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","minLength":1}},"required":["name"],"additionalProperties":false}`)}
}

func (r Rule) Run(_ context.Context, call Call) (Result, error) {
	var input struct {
		Name string `json:"name"`
	}
	if err := DecodeInput(call.Input, &input); err != nil {
		return Failure(err), nil
	}
	if r.Lookup == nil {
		return Failure(errors.New("this project has no rules to read")), nil
	}
	body, ok := r.Lookup(input.Name)
	if !ok {
		return Failure(errors.New("no such rule")), nil
	}
	return Result{Parts: []model.Part{{Text: body}}}, nil
}
