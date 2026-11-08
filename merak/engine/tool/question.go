package tool

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/question"
)

type AskUser struct {
	Bus *event.Bus
	Ask func(context.Context, question.Request) (question.Answer, error)
}

func (AskUser) Spec() Spec {
	return Spec{Name: "ask_user", Description: "Ask the user one question, with optional suggested answers. In a group, use to to name a human member. Wait for the reply before continuing.", Effect: EffectGroup, Input: json.RawMessage(`{"type":"object","properties":{"text":{"type":"string"},"to":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["text"],"additionalProperties":false}`)}
}

func (q AskUser) Run(ctx context.Context, call Call) (Result, error) {
	var request question.Request
	if err := decodeInput(call.Input, &request); err != nil {
		return failure(err), nil
	}
	if strings.TrimSpace(request.Text) == "" {
		return failure(errors.New("question text is required")), nil
	}
	if q.Ask == nil || q.Bus == nil {
		return failure(errors.New("no question recipient is connected")), nil
	}
	data, _ := json.Marshal(request)
	fact, err := q.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + call.Env.Scope.Session), Scope: call.Env.Scope, Actor: event.Actor{Kind: event.ActorAgent}, Type: question.Asked, Payload: data})
	if err != nil {
		return Result{}, err
	}
	request.ID = fact.ID
	answer, askErr := q.Ask(ctx, request)
	if askErr != nil {
		answer = question.Answer{Cancelled: true}
	}
	data, _ = json.Marshal(answer)
	_, err = q.Bus.Publish(context.WithoutCancel(ctx), event.Event{Stream: fact.Stream, Scope: fact.Scope, Actor: event.Actor{Kind: event.ActorHuman, ID: answer.Human}, Type: question.Answered, Cause: fact.ID, Payload: data})
	if err != nil {
		return Result{}, err
	}
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	if askErr != nil {
		return failure(askErr), nil
	}
	if answer.Cancelled {
		return failure(errors.New("the question was cancelled")), nil
	}
	return Result{Parts: []model.Part{{Text: answer.Text}}}, nil
}
