package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Children interface {
	Spawn(context.Context, string) (event.ID, error)
	Wait(context.Context, event.ID) error
}

// AgentChildren is a Children that can also start a child as a named agent.
type AgentChildren interface {
	SpawnAgent(ctx context.Context, agent, prompt string) (event.ID, error)
}

type Spawn struct{}

func (Spawn) Spec() Spec {
	return Spec{Name: "spawn", Description: "Start a read-only background child to research a question here. Its report arrives automatically.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"prompt":{"type":"string","minLength":1},"profile":{"type":"string","enum":["readonly"]},"agent":{"type":"string"}},"required":["prompt"],"additionalProperties":false}`)}
}

func (Spawn) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Prompt  string `json:"prompt"`
		Profile string `json:"profile"`
		Agent   string `json:"agent"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if strings.TrimSpace(input.Prompt) == "" || input.Profile != "" && input.Profile != "readonly" {
		return failure(errors.New("prompt and a read-only profile are required")), nil
	}
	if call.Env.Children == nil {
		return failure(errors.New("children are not available in this session")), nil
	}
	var id event.ID
	var err error
	if agents, ok := call.Env.Children.(AgentChildren); ok && input.Agent != "" {
		id, err = agents.SpawnAgent(ctx, input.Agent, input.Prompt)
	} else if input.Agent != "" {
		err = errors.New("this session cannot start agents")
	} else {
		id, err = call.Env.Children.Spawn(ctx, input.Prompt)
	}
	if err != nil {
		return failure(err), nil
	}
	body, _ := json.Marshal(map[string]event.ID{"id": id})
	return Result{ChildID: id, Parts: []model.Part{{Text: string(body)}}}, nil
}

type WaitChild struct{}

func (WaitChild) Spec() Spec {
	return Spec{Name: "wait_child", Description: "Wait for an owned child to finish. Its report is appended after this tool result.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","minLength":1}},"required":["id"],"additionalProperties":false}`)}
}

func (WaitChild) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		ID event.ID `json:"id"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.ID == "" || call.Env.Children == nil {
		return failure(errors.New("an owned child id is required")), nil
	}
	if err := call.Env.Children.Wait(ctx, input.ID); err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "Child " + string(input.ID) + " finished. Its report follows."}}}, nil
}
