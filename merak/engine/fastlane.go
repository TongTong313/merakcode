package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type claimRun struct {
	run  worker.Run
	caps worker.Caps
}

func (e *Engine) forwardHuman(ctx context.Context, g *groupRun, fact event.Event) bool {
	message, err := event.Decode[group.Message](fact)
	if err != nil || len(message.To) == 0 && fact.Scope.Task == "" {
		return false
	}
	cards, err := e.Tasks.List(ctx, g.group.ID)
	if err != nil {
		return false
	}
	recipients := make(map[event.ID]bool)
	for _, id := range message.To {
		recipients[id] = false
	}
	forwarded := false
	for _, card := range cards {
		if len(recipients) == 0 && card.ID != fact.Scope.Task {
			continue
		}
		for _, claim := range card.Claims {
			if claim.Status != task.ClaimActive {
				continue
			}
			if len(message.To) > 0 {
				if _, ok := recipients[claim.Member]; !ok {
					continue
				}
			}
			e.mu.Lock()
			active, ok := e.claimRuns[claim.ID]
			e.mu.Unlock()
			if !ok || !active.caps.Steer {
				continue
			}
			if err := active.run.Send(ctx, loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: message.Text}}}); err != nil {
				continue
			}
			forwarded = true
			if len(message.To) > 0 {
				recipients[claim.Member] = true
			}
		}
	}
	for id, sent := range recipients {
		if sent {
			continue
		}
		member, err := e.groupMember(ctx, g.group.ID, id)
		if err != nil || member.AgentRole != group.AgentWorker {
			return false
		}
		busy := false
		for _, card := range cards {
			for _, claim := range card.Claims {
				if claim.Member == id && claim.Status == task.ClaimActive {
					busy = true
				}
			}
		}
		if busy {
			return false
		}
		_, err = e.CreateAssignedTask(ctx, task.Card{Group: g.group.ID, Title: message.Text, Description: message.Text, CreatedBy: fact.Actor}, id)
		if err != nil {
			return false
		}
		forwarded = true
	}
	if !forwarded && len(message.To) == 0 && fact.Scope.Task != "" {
		return e.Tasks.RecordDiscussion(ctx, fact.Scope.Task, fact.ID) == nil
	}
	return forwarded
}
