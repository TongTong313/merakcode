package roster

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type GroupTool struct {
	Definition tool.Spec
	RunFunc    func(context.Context, tool.Call) (any, error)
}

func (t GroupTool) Spec() tool.Spec { return t.Definition }

func (t GroupTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	value, err := t.RunFunc(ctx, call)
	if err != nil {
		return tool.Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: err.Error()}}}, nil
	}
	body, err := json.Marshal(value)
	if err != nil {
		return tool.Result{}, err
	}
	return tool.Result{Parts: []model.Part{{Text: string(body)}}}, nil
}

func DecodeGroupInput(body []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected one JSON object")
	}
	return nil
}

func (domain *Roster) TaskRoot(ctx context.Context, card task.Card) (event.ID, error) {
	for card.Parent != "" {
		parent, err := domain.tasks.Get(ctx, card.Parent)
		if err != nil {
			return "", err
		}
		card = parent
	}
	return card.ID, nil
}

func (domain *Roster) ScopedTask(ctx context.Context, g event.ID, thread *leader.Thread, id event.ID) (task.Card, error) {
	card, err := domain.tasks.Get(ctx, id)
	if err != nil {
		return task.Card{}, err
	}
	root, err := domain.TaskRoot(ctx, card)
	if err != nil {
		return task.Card{}, err
	}
	if card.Group != g || thread.Key != g && root != thread.Key {
		return task.Card{}, errors.New("task is outside this leader thread")
	}
	return card, nil
}
