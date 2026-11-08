package engine

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func (e *Engine) publishTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "publish", Description: "Publish the files declared in a successful folder claim's report to the artifact library. This preserves the original project files and keeps the task available for human review.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"claim":{"type":"string"}},"required":["task","claim"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task  event.ID `json:"task"`
			Claim event.ID `json:"claim"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		card, err := e.scopedTask(ctx, g.group.ID, thread, input.Task)
		if err != nil {
			return nil, err
		}
		for _, claim := range card.Claims {
			if claim.ID != input.Claim {
				continue
			}
			if claim.Status != task.ClaimReported || claim.Report == nil || claim.Report.Verdict != task.VerdictDone {
				return nil, errors.New("publication requires a successful report")
			}
			if len(claim.Published) > 0 {
				return claim.Published, nil
			}
			ws, err := e.Workspaces.Get(ctx, claim.Workspace)
			if err != nil {
				return nil, err
			}
			ids, err := e.Workspaces.Publish(ctx, ws, claim.Report.Artifacts)
			if err != nil {
				return nil, err
			}
			return ids, e.Tasks.MarkPublished(ctx, claim.ID, ids)
		}
		return nil, errors.New("claim is outside this task")
	}}
}
