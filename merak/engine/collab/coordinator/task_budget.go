package coordinator

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) updateTaskTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "update_task", Description: "Request an owner-approved budget increase for this task. Provide token, cost or wall-clock increments and a reason. Reassign the original member after approval to continue its session.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"reason":{"type":"string"},"budget":{"type":"object","properties":{"tokens":{"type":"integer","minimum":0},"cost":{"type":"number","minimum":0},"wallClock":{"type":"integer","minimum":0}},"additionalProperties":false}},"required":["task","reason","budget"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Task event.ID `json:"task"`
			task.Update
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		if _, err := domain.roster.ScopedTask(ctx, g.group.ID, thread, input.Task); err != nil {
			return nil, err
		}
		if err := domain.execution.UpdateTask(ctx, input.Task, input.Update, event.Actor{Kind: event.ActorAgent, ID: thread.Leader}); err != nil {
			return nil, err
		}
		return domain.tasks.Get(ctx, input.Task)
	}}
}
