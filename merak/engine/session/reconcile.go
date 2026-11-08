package session

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// Reconcile completes abandoned calls in message order without executing them again.
func (m *Manager) Reconcile(ctx context.Context, state *State) error {
	if err := CloseInterruptedCalls(ctx, m.bus, state); err != nil {
		return err
	}
	var children []event.ID
	for id, child := range state.Children {
		if !child.Delivered {
			children = append(children, id)
		}
	}
	slices.Sort(children)
	for _, id := range children {
		result := ChildResult{ID: id, Stop: "cancelled", Code: "MRK-5003", Report: []model.Part{{Text: "Child execution was interrupted."}}}
		child, err := m.Load(ctx, id)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if err == nil && child.Config.Parent == state.ID {
			if err := m.Reconcile(ctx, child); err != nil {
				return err
			}
			facts, err := m.store.Find(ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
			if err != nil {
				return err
			}
			if len(facts) > 0 {
				var outcome struct {
					Stop  string       `json:"stop"`
					Final []model.Part `json:"final"`
					Code  string       `json:"code"`
				}
				if err := json.Unmarshal(facts[len(facts)-1].Payload, &outcome); err != nil {
					return err
				}
				if len(outcome.Final) > 0 {
					result.Report = outcome.Final
					result.Stop = outcome.Stop
					result.Code = outcome.Code
				}
			}
		}
		if err := reconcileEvent(ctx, m.bus, state, ChildFinished, result, ""); err != nil {
			return err
		}
	}
	if state.Status == Running || state.Status == WaitingHuman {
		return reconcileEvent(ctx, m.bus, state, "turn.finished", struct {
			Stop  string      `json:"stop"`
			Usage model.Usage `json:"usage"`
		}{Stop: "cancelled"}, "")
	}
	return nil
}

// CloseInterruptedCalls pairs abandoned calls after a live cancellation or restart.
func CloseInterruptedCalls(ctx context.Context, bus *event.Bus, state *State) error {
	for _, message := range state.Messages {
		for _, part := range message.Parts {
			if part.ToolCall == nil {
				continue
			}
			call, open := state.Open[part.ToolCall.ID]
			if !open {
				continue
			}
			result := tool.Completion{CallID: call.ID, Name: call.Name, Result: tool.Result{IsError: true, Code: "MRK-5003", Parts: []model.Part{{Text: "Tool execution was interrupted."}}}}
			if err := reconcileEvent(ctx, bus, state, tool.Completed, result, state.Causes[call.ID]); err != nil {
				return err
			}
		}
	}
	return nil
}

func reconcileEvent(ctx context.Context, bus *event.Bus, state *State, kind event.Type, value any, cause event.ID) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	fact, err := bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + state.ID), Scope: state.Scope, Type: kind, Actor: event.Actor{Kind: event.ActorAgent, ID: state.Config.Member}, Cause: cause, Payload: body})
	if err != nil {
		return err
	}
	return Fold(state, fact)
}
