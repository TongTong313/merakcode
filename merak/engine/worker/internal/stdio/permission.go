package stdio

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type approval struct{ spec tool.Spec }

func (a approval) Spec() tool.Spec                                   { return a.spec }
func (approval) Run(context.Context, tool.Call) (tool.Result, error) { return tool.Result{}, nil }

// Approve applies the same gate as builtin tools before answering a product request.
func (j *Journal) Approve(ctx context.Context, gate *permission.Gate, id, name string, effect tool.Effect, input json.RawMessage) (bool, error) {
	if gate == nil || j.Assignment.ReadOnly && effect != tool.EffectRead {
		return false, nil
	}
	guarded := gate.Wrap(approval{tool.Spec{Name: name, Description: "Approve the external worker operation.", Effect: effect, Input: json.RawMessage(`{"type":"object"}`)}})
	result, err := guarded.Run(ctx, tool.Call{ID: id, Name: name, Input: input, Env: tool.Env{Scope: j.Scope, Workdir: j.Assignment.Workdir, Mode: string(j.Assignment.Mode)}})
	return err == nil && !result.IsError, err
}
