package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type EditFile struct{}

func (EditFile) Spec() Spec {
	return Spec{
		Name: "edit_file", Description: "Replace exactly one occurrence of oldText with newText. Requires permission.",
		Effect: EffectWrite,
		Input:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1},"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["path","oldText","newText"],"additionalProperties":false}`),
	}
}

func (EditFile) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path    string  `json:"path"`
		OldText string  `json:"oldText"`
		NewText *string `json:"newText"`
	}
	decoder := json.NewDecoder(bytes.NewReader(call.Input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return failure(err), nil
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure(errors.New("expected one JSON object")), nil
	}
	if input.Path == "" || input.OldText == "" || input.NewText == nil {
		return failure(errors.New("path, non-empty oldText, and newText are required")), nil
	}
	path := input.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(call.Env.Workdir, path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return failure(err), nil
	}
	if !call.Env.Reads.current(path, data) {
		return failure(errors.New("file has not been read or has changed; read it again before editing")), nil
	}
	if strings.Count(string(data), input.OldText) != 1 {
		return failure(errors.New("oldText must match exactly once")), nil
	}
	updated := strings.Replace(string(data), input.OldText, *input.NewText, 1)
	if err := os.WriteFile(path, []byte(updated), 0o600); err != nil {
		return failure(err), nil
	}
	call.Env.Reads.remember(path, []byte(updated))
	return Result{Parts: []model.Part{{Text: "File edited."}}}, nil
}
