package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type WriteFile struct{}

func (WriteFile) Spec() Spec {
	return Spec{
		Name: "write_file", Description: "Create or replace a file. Requires permission before writing.",
		Effect: EffectWrite,
		Input:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}`),
	}
}

func (WriteFile) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path    string  `json:"path"`
		Content *string `json:"content"`
	}
	decoder := json.NewDecoder(bytes.NewReader(call.Input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return failure(err), nil
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure(errors.New("expected one JSON object")), nil
	}
	if input.Path == "" || input.Content == nil {
		return failure(errors.New("path and content are required")), nil
	}
	path := input.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(call.Env.Workdir, path)
	}
	if err := os.WriteFile(path, []byte(*input.Content), 0o600); err != nil {
		return failure(err), nil
	}
	call.Env.Reads.remember(path, []byte(*input.Content))
	return Result{Parts: []model.Part{{Text: "File written."}}}, nil
}
