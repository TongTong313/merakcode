package tool

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/pathglob"
)

type Glob struct{}

func (Glob) Spec() Spec {
	return Spec{Name: "glob", Description: "Find files by path pattern. ** matches zero or more directories.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string","minLength":1},"path":{"type":"string"}},"required":["pattern"],"additionalProperties":false}`)}
}

func (Glob) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Pattern == "" {
		return failure(errors.New("pattern is required")), nil
	}
	pattern, err := pathglob.Compile(filepath.ToSlash(input.Pattern))
	if err != nil {
		return failure(err), nil
	}
	root := resolvePath(call.Env.Workdir, input.Path)
	var matches []string
	err = filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if pattern.Match(relative) {
			matches = append(matches, relative)
		}
		return nil
	})
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: strings.Join(matches, "\n")}}}, nil
}
