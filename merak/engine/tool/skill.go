package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// Skill loads a skill: its instructions, and the files that come with it.
type Skill struct {
	// Read returns the instructions of a skill and the absolute paths of its files.
	Read func(name string) (body string, files []string, ok bool)
}

func (Skill) Spec() Spec {
	return Spec{Name: "skill", Description: "Load a skill listed in the system prompt by name; returns its instructions and file paths. Use it when the task fits the skill.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","minLength":1}},"required":["name"],"additionalProperties":false}`)}
}

func (s Skill) Run(_ context.Context, call Call) (Result, error) {
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if s.Read == nil {
		return failure(errors.New("there are no skills")), nil
	}
	body, files, ok := s.Read(input.Name)
	if !ok {
		return failure(errors.New("no such skill")), nil
	}
	text := body
	if len(files) > 0 {
		text += "\n\nFiles of this skill:\n- " + strings.Join(files, "\n- ")
	}
	return Result{Parts: []model.Part{{Text: text}}}, nil
}
