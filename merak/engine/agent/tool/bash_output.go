package tool

import (
	"context"
	"encoding/json"
	"errors"
)

type BashOutput struct{}

func (BashOutput) Spec() Spec {
	return Spec{Name: "bash_output", Description: "Get the current output and exit status of a background bash command by id.", Effect: EffectExec,
		Input: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","minLength":1}},"required":["id"],"additionalProperties":false}`)}
}

func (BashOutput) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		ID string `json:"id"`
	}
	if err := DecodeInput(call.Input, &input); err != nil {
		return Failure(err), nil
	}
	if input.ID == "" {
		return Failure(errors.New("id is required")), nil
	}
	return call.Env.Jobs.output(input.ID), nil
}
