package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// Todo is one line of the working list a model keeps for itself.
type Todo struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// TodoWrite replaces the whole todo list. The list lives in the session: the loop announces each accepted
// call and the session state keeps the latest one.
type TodoWrite struct{}

const todoName = "todo_write"

func (TodoWrite) Spec() Spec {
	return Spec{Name: todoName, Description: "Replace your todo list for multi-step work. Send the whole list; each item has content and a status (pending, in_progress, done). At most one in_progress.", Effect: EffectRead, Input: json.RawMessage(`{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string","minLength":1},"status":{"type":"string","enum":["pending","in_progress","done"]}},"required":["content","status"],"additionalProperties":false}}},"required":["items"],"additionalProperties":false}`)}
}

func (TodoWrite) Run(_ context.Context, call Call) (Result, error) {
	_, err := ParseTodos(call.Input)
	if err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "Todo list updated."}}}, nil
}

// ParseTodos validates the input of a todo_write call and returns its list.
func ParseTodos(input []byte) ([]Todo, error) {
	var value struct {
		Items []Todo `json:"items"`
	}
	if err := decodeInput(input, &value); err != nil {
		return nil, errors.New("invalid todo list: " + err.Error())
	}
	active := 0
	for _, item := range value.Items {
		if strings.TrimSpace(item.Content) == "" {
			return nil, errors.New("invalid todo list: every todo needs content")
		}
		switch item.Status {
		case "pending", "done":
		case "in_progress":
			active++
		default:
			return nil, errors.New("invalid todo list: a todo status is pending, in_progress or done")
		}
	}
	if active > 1 {
		return nil, errors.New("invalid todo list: keep at most one todo in_progress")
	}
	return value.Items, nil
}

// IsTodoWrite reports whether a tool name is the todo list tool.
func IsTodoWrite(name string) bool { return name == todoName }
