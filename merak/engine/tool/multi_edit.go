package tool

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// MultiEdit makes several replacements in one file, in order, as a single change: if any of them cannot be made the
// file is left as it was. It asks for the same permission as edit_file and is undone the same way.
type MultiEdit struct{}

func (MultiEdit) Spec() Spec {
	return Spec{
		Name: "multi_edit", Description: "Make several replacements in one file, in order; each replaces exactly one occurrence of oldText. If one fails, nothing changes. Needs permission.",
		Effect: EffectWrite,
		Input:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string","minLength":1},"edits":{"type":"array","minItems":1,"items":{"type":"object","properties":{"oldText":{"type":"string","minLength":1},"newText":{"type":"string"}},"required":["oldText","newText"],"additionalProperties":false}}},"required":["path","edits"],"additionalProperties":false}`),
	}
}

func (MultiEdit) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path  string `json:"path"`
		Edits []struct {
			OldText string  `json:"oldText"`
			NewText *string `json:"newText"`
		} `json:"edits"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Path == "" || len(input.Edits) == 0 {
		return failure(fmt.Errorf("path and at least one edit are required")), nil
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
		return failure(fmt.Errorf("file has not been read or has changed; read it again before editing")), nil
	}
	text := string(data)
	for i, edit := range input.Edits {
		if edit.OldText == "" || edit.NewText == nil {
			return failure(fmt.Errorf("edit %d needs a non-empty oldText and a newText", i+1)), nil
		}
		if count := strings.Count(text, edit.OldText); count != 1 {
			return failure(fmt.Errorf("edit %d: oldText must match exactly once, it matches %d times; nothing was changed", i+1, count)), nil
		}
		text = strings.Replace(text, edit.OldText, *edit.NewText, 1)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return failure(err), nil
	}
	call.Env.Reads.remember(path, []byte(text))
	return Result{Parts: []model.Part{{Text: fmt.Sprintf("File edited with %d replacements.", len(input.Edits))}}}, nil
}
