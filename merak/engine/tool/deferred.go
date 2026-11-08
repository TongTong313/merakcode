package tool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type loadTools struct{ pool *Pool }

func (loadTools) Spec() Spec {
	return Spec{Name: "load_tools", Description: "Load deferred tools by name and return their schemas. Load a tool before using call_tool.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"names":{"type":"array","items":{"type":"string","minLength":1},"minItems":1,"uniqueItems":true}},"required":["names"],"additionalProperties":false}`)}
}

func (l loadTools) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Names []string `json:"names"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if len(input.Names) == 0 {
		return failure(errors.New("names must not be empty")), nil
	}
	var specs []Spec
	loaded := make(map[string]bool)
	for _, name := range input.Names {
		t, ok := l.pool.Deferred[name]
		if !ok {
			return failure(fmt.Errorf("unknown deferred tool: %s", name)), nil
		}
		if _, ok := loaded[name]; ok {
			return failure(errors.New("tool names must be unique")), nil
		}
		loaded[name] = true
		specs = append(specs, t.Spec())
	}
	body, err := json.Marshal(specs)
	if err != nil {
		return Result{}, err
	}
	l.pool.mu.Lock()
	if l.pool.loaded == nil {
		l.pool.loaded = make(map[string]bool)
	}
	for name := range loaded {
		l.pool.loaded[name] = true
	}
	l.pool.mu.Unlock()
	return Result{Parts: []model.Part{{Text: string(body)}}}, nil
}

type callTool struct{ pool *Pool }

func (callTool) Spec() Spec {
	return Spec{Name: "call_tool", Description: "Execute a previously loaded tool with its own input validation and permission checks.", Effect: EffectExec,
		Input: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","minLength":1},"input":{"type":"object"}},"required":["name","input"],"additionalProperties":false}`)}
}

func (c callTool) Run(ctx context.Context, call Call) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	var input struct {
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	c.pool.mu.Lock()
	loaded := c.pool.loaded[input.Name]
	c.pool.mu.Unlock()
	if !loaded {
		return failure(errors.New("use load_tools before calling this tool")), nil
	}
	t, ok := c.pool.Deferred[input.Name]
	if !ok {
		return failure(errors.New("deferred tool is unavailable")), nil
	}
	call.Name, call.Input = input.Name, input.Input
	return t.Run(ctx, call)
}
