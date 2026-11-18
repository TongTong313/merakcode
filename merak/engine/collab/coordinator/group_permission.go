package coordinator

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) PendingPermissions(ctx context.Context) ([]event.Event, error) {
	var facts []event.Event
	for _, id := range domain.permissions.PendingHumans() {
		fact, err := domain.core.Store.Get(ctx, id)
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

func (domain *Coordinator) approveTool(g *groupRun, thread *leader.Thread) tool.Tool {
	return roster.GroupTool{Definition: tool.Spec{Name: "approve", Description: "Answer a routine Worker permission request in this task thread. Use its request ID. Use ask_human with request to escalate when uncertain. Admin and owner requests require a human.", Effect: tool.EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"request":{"type":"string"},"decision":{"type":"string","enum":["allow","deny"]}},"required":["request","decision"],"additionalProperties":false}`)}, RunFunc: func(ctx context.Context, call tool.Call) (any, error) {
		var input struct {
			Request  event.ID            `json:"request"`
			Decision permission.Decision `json:"decision"`
		}
		if err := roster.DecodeGroupInput(call.Input, &input); err != nil {
			return nil, err
		}
		err := domain.permissions.Approve(ctx, input.Request, g.group.ID, thread.Key, thread.Leader, input.Decision)
		return input.Decision, err
	}}
}
