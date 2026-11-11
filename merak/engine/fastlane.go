package engine

import (
	"context"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type claimRun struct {
	run     worker.Run
	caps    worker.Caps
	sources []event.ID
}

type claimPreparation struct {
	cancel context.CancelFunc
	inputs []loop.Input
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
			if !e.sendClaimInput(ctx, g.group.ID, claim, loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: message.Text}}}) {
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

func (e *Engine) sendClaimInput(ctx context.Context, groupID event.ID, claim task.Claim, input loop.Input) bool {
	e.mu.Lock()
	active, running := e.claimRuns[claim.ID]
	e.mu.Unlock()
	if !running {
		member, err := e.groupMember(ctx, groupID, claim.Member)
		if err != nil {
			return false
		}
		p, err := e.memberAgent(ctx, member)
		if err != nil || !e.runnerFor(p, nil).Caps().Steer {
			return false
		}
		e.mu.Lock()
		active, running = e.claimRuns[claim.ID]
		if !running && e.claimPreparing[claim.ID] != nil {
			preparing := e.claimPreparing[claim.ID]
			preparing.inputs = append(preparing.inputs, input)
			e.mu.Unlock()
			return true
		}
		e.mu.Unlock()
	}
	if !running || !active.caps.Steer {
		return false
	}
	if input.Cause != "" && slices.Contains(active.sources, input.Cause) {
		return true
	}
	return active.run.Send(ctx, input) == nil
}
