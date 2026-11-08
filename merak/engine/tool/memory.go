package tool

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/memory"
	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Remember struct{ Memory *memory.Repository }

func (Remember) Spec() Spec {
	return Spec{Name: "remember", Description: "Save one durable fact, decision, preference or pitfall. Never store credentials. The default scope is the current project.", Effect: EffectWrite,
		Input: json.RawMessage(`{"type":"object","properties":{"scope":{"type":"string","enum":["member","group","project"]},"kind":{"type":"string","enum":["fact","decision","preference","pitfall"]},"text":{"type":"string","minLength":1},"tags":{"type":"array","items":{"type":"string"}}},"required":["kind","text"],"additionalProperties":false}`)}
}

func (t Remember) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Scope memory.Scope `json:"scope"`
		Kind  string       `json:"kind"`
		Text  string       `json:"text"`
		Tags  []string     `json:"tags"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Scope == "" {
		input.Scope = memory.ScopeProject
	}
	for _, owner := range call.Env.MemoryOwners {
		if owner.Scope != input.Scope {
			continue
		}
		note, err := t.Memory.Remember(ctx, memory.Note{Scope: owner.Scope, Owner: owner.ID, Kind: input.Kind, Text: input.Text, Tags: input.Tags, Source: call.Env.Scope.Session})
		if err != nil {
			return failure(err), nil
		}
		return Result{Parts: []model.Part{{Text: "Remembered note " + string(note.ID)}}}, nil
	}
	return failure(errors.New("memory scope is not available in this session")), nil
}

type Recall struct{ Memory memory.Recall }

func (Recall) Spec() Spec {
	return Spec{Name: "recall", Description: "Find relevant notes in the current member, group and project scopes by keywords or file tags.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"limit":{"type":"integer","minimum":1,"maximum":50}},"additionalProperties":false}`)}
}

func (t Recall) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Query string   `json:"query"`
		Tags  []string `json:"tags"`
		Limit int      `json:"limit"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if input.Limit < 0 || input.Limit > 50 {
		return failure(errors.New("limit must be between 1 and 50")), nil
	}
	notes, err := t.Memory.Recall(ctx, memory.Query{Owners: call.Env.MemoryOwners, Text: input.Query, Tags: input.Tags, Limit: input.Limit})
	if err != nil {
		return failure(err), nil
	}
	text := memory.Format(notes)
	if text == "" {
		text = "No matching notes."
	}
	return Result{Parts: []model.Part{{Text: text}}}, nil
}
