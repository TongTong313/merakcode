package tool

import (
	"context"
	"encoding/json"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type ListDir struct{}

func (ListDir) Spec() Spec {
	return Spec{Name: "list_dir", Description: "List immediate directory entries in name order. Directories end with a slash.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false}`)}
}

func (ListDir) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Path string `json:"path"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	entries, err := os.ReadDir(resolvePath(call.Env.Workdir, input.Path))
	if err != nil {
		return failure(err), nil
	}
	var names []string
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			name += "/"
		}
		names = append(names, name)
	}
	return Result{Parts: []model.Part{{Text: strings.Join(names, "\n")}}}, nil
}
