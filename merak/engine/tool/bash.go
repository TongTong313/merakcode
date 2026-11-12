package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Bash struct{}

func (Bash) Spec() Spec {
	return Spec{
		Name: "bash", Description: "Run a bash command in the working directory with a two-minute timeout. Requires permission.",
		Effect: EffectExec,
		Input:  json.RawMessage(`{"type":"object","properties":{"command":{"type":"string","minLength":1},"background":{"type":"boolean"}},"required":["command"],"additionalProperties":false}`),
	}
}

func (Bash) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Command    string `json:"command"`
		Background bool   `json:"background"`
	}
	decoder := json.NewDecoder(bytes.NewReader(call.Input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return failure(err), nil
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure(errors.New("expected one JSON object")), nil
	}
	if input.Command == "" {
		return failure(errors.New("command is required")), nil
	}
	if input.Background {
		return call.Env.Jobs.start(ctx, call.Env, input.Command)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd, err := process.Shell(ctx, call.Env.Workdir, input.Command)
	if err != nil {
		return failure(err), nil
	}
	if call.Env.Sandbox != nil {
		cmd, err = call.Env.Sandbox.Command(ctx, call.Env.SandboxProfile, cmd.Path, cmd.Args[1:]...)
		if err != nil {
			return failure(err), nil
		}
		cmd.Dir = call.Env.Workdir
	}
	var buffer bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buffer, &buffer
	runErr := call.Env.Sandbox.Start(cmd, call.Env.SandboxProfile)
	if runErr == nil {
		runErr = call.Env.Sandbox.Wait(cmd)
	}
	output := buffer.Bytes()
	exit := -1
	if cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() != nil {
		exit = -1
		output = append(output, "\nCommand timed out or was cancelled."...)
	}
	result := Result{Parts: []model.Part{{Text: string(output)}}, ExitCode: &exit}
	if runErr != nil {
		result.IsError = true
		result.Code = "MRK-5001"
		var denied *sandbox.DenialError
		if errors.As(runErr, &denied) {
			result.Code = "MRK-5009"
			result.Parts = append(result.Parts, model.Part{Text: denied.Error()})
		}
		var protected *sandbox.ProtectionError
		if errors.As(runErr, &protected) {
			result.Code = "MRK-5007"
			result.Parts = append(result.Parts, model.Part{Text: protected.Error()})
		}
	}
	return result, nil
}
