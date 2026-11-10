package engine

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func (e *Engine) PendingPermissions(ctx context.Context) ([]event.Event, error) {
	var facts []event.Event
	for _, id := range e.permissions.PendingHumans() {
		fact, err := e.store.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		req, err := event.Decode[permission.Request](fact)
		if err != nil {
			return nil, err
		}
		req.Leader = ""
		fact.Payload, err = json.Marshal(req)
		if err != nil {
			return nil, err
		}
		facts = append(facts, fact)
	}
	return facts, nil
}

func (e *Engine) approveTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return groupTool{spec: tool.Spec{Name: "approve", Description: "Answer a routine Worker permission request in this task thread. Use its request ID. Use ask_human with request to escalate when uncertain. Admin and owner requests require a human.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"request":{"type":"string"},"decision":{"type":"string","enum":["allow","deny"]}},"required":["request","decision"],"additionalProperties":false}`)}, run: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Request  event.ID            `json:"request"`
			Decision permission.Decision `json:"decision"`
		}
		if err := decodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		err := e.permissions.Approve(ctx, input.Request, g.group.ID, thread.Key, thread.Leader, input.Decision)
		return input.Decision, err
	}}
}
