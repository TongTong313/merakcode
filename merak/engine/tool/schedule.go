package tool

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

// ScheduleInfo is what the schedule tools tell the model about one scheduled task.
type ScheduleInfo struct {
	ID     string `json:"id"`
	Cron   string `json:"cron"`
	Prompt string `json:"prompt"`
	Agent  string `json:"agent,omitempty"`
	// Next is the next run in RFC 3339, in the machine's time zone.
	Next string `json:"next,omitempty"`
}

// Scheduler creates, lists and deletes the scheduled tasks of the folder a conversation works in.
type Scheduler interface {
	Create(ctx context.Context, cron, prompt, agent string) (ScheduleInfo, error)
	List(ctx context.Context) ([]ScheduleInfo, error)
	Delete(ctx context.Context, id string) error
}

// ScheduleCreate is the schedule_create tool.
type ScheduleCreate struct{ Scheduler Scheduler }

func (ScheduleCreate) Spec() Spec {
	return Spec{Name: "schedule_create", Description: "Run a prompt on a schedule in this folder, in a new conversation each time. cron has five fields (minute hour day-of-month month day-of-week) in the machine's time zone, for example 0 9 * * 1-5. Needs permission.", Effect: EffectWrite,
		Input: json.RawMessage(`{"type":"object","properties":{"cron":{"type":"string","minLength":1},"prompt":{"type":"string","minLength":1},"agent":{"type":"string"}},"required":["cron","prompt"],"additionalProperties":false}`)}
}

func (t ScheduleCreate) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		Cron   string `json:"cron"`
		Prompt string `json:"prompt"`
		Agent  string `json:"agent"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if t.Scheduler == nil {
		return failure(errors.New("scheduling is not available here")), nil
	}
	created, err := t.Scheduler.Create(ctx, input.Cron, input.Prompt, input.Agent)
	if err != nil {
		return failure(err), nil
	}
	return jsonResult(created)
}

// ScheduleList is the schedule_list tool.
type ScheduleList struct{ Scheduler Scheduler }

func (ScheduleList) Spec() Spec {
	return Spec{Name: "schedule_list", Description: "List the scheduled tasks of this folder with their ids and next runs.", Effect: EffectRead,
		Input: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}
}

func (t ScheduleList) Run(ctx context.Context, call Call) (Result, error) {
	if err := decodeInput(call.Input, &struct{}{}); err != nil {
		return failure(err), nil
	}
	if t.Scheduler == nil {
		return failure(errors.New("scheduling is not available here")), nil
	}
	listed, err := t.Scheduler.List(ctx)
	if err != nil {
		return failure(err), nil
	}
	if listed == nil {
		listed = []ScheduleInfo{}
	}
	return jsonResult(listed)
}

// ScheduleDelete is the schedule_delete tool.
type ScheduleDelete struct{ Scheduler Scheduler }

func (ScheduleDelete) Spec() Spec {
	return Spec{Name: "schedule_delete", Description: "Delete a scheduled task by id; it never runs again. List first when unsure which one. Needs permission.", Effect: EffectWrite,
		Input: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","minLength":1}},"required":["id"],"additionalProperties":false}`)}
}

func (t ScheduleDelete) Run(ctx context.Context, call Call) (Result, error) {
	var input struct {
		ID string `json:"id"`
	}
	if err := decodeInput(call.Input, &input); err != nil {
		return failure(err), nil
	}
	if t.Scheduler == nil {
		return failure(errors.New("scheduling is not available here")), nil
	}
	if err := t.Scheduler.Delete(ctx, input.ID); err != nil {
		return failure(err), nil
	}
	return Result{Parts: []model.Part{{Text: "Deleted " + input.ID}}}, nil
}

func jsonResult(value any) (Result, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return Result{}, err
	}
	return Result{Parts: []model.Part{{Text: string(body)}}}, nil
}
