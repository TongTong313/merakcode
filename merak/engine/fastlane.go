package engine

import (
	"context"
	"encoding/json"
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
			if !e.sendClaimInput(ctx, g.group.ID, claim, loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: e.humanWord(ctx, g.group.ID, fact.Actor, message.Text)}}}) {
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
		_, err = e.CreateAssignedTask(ctx, task.Card{Group: g.group.ID, Title: task.TitleFrom(message.Text), Description: message.Text, CreatedBy: fact.Actor}, id)
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

// humanWord wraps a human's message for a member: the human's word overrides the Leader's instructions.
func (e *Engine) humanWord(ctx context.Context, groupID event.ID, actor event.Actor, text string) string {
	name := string(actor.ID)
	if member, err := e.groupMember(ctx, groupID, actor.ID); err == nil && member.Name != "" {
		name = member.Name
	}
	return "Message from " + name + " (a human; this overrides the Leader's instructions): " + text
}

func (e *Engine) sendClaimInput(ctx context.Context, groupID event.ID, claim task.Claim, input loop.Input) bool {
	e.mu.Lock()
	active, running := e.claimRuns[claim.ID]
	e.mu.Unlock()
	human := input.Actor.Kind == event.ActorHuman
	if !running {
		member, err := e.groupMember(ctx, groupID, claim.Member)
		if err != nil {
			return false
		}
		p, err := e.memberAgent(ctx, member)
		if err != nil || !human && !e.runnerFor(p, nil).Caps().Steer {
			return false
		}
		e.mu.Lock()
		active, running = e.claimRuns[claim.ID]
		if !running && e.claimPreparing[claim.ID] != nil {
			preparing := e.claimPreparing[claim.ID]
			preparing.inputs = append(preparing.inputs, input)
			e.mu.Unlock()
			e.receiptInput(ctx, groupID, claim, input)
			return true
		}
		e.mu.Unlock()
	}
	if !running {
		return false
	}
	if input.Cause != "" && slices.Contains(active.sources, input.Cause) {
		return true
	}
	if !active.caps.Steer {
		if !human {
			return false
		}
		e.receiptInput(ctx, groupID, claim, input)
		return e.restartClaim(ctx, claim.ID, active, input)
	}
	e.receiptInput(ctx, groupID, claim, input)
	return active.run.Send(ctx, input) == nil
}

// receiptInput tells every client that an input reached a running member; loop.InputConsumed follows when
// the model reads it.
func (e *Engine) receiptInput(ctx context.Context, groupID event.ID, claim task.Claim, input loop.Input) {
	body, err := json.Marshal(loop.Delivered{Claim: claim.ID})
	if err != nil {
		return
	}
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID, Task: claim.Task, Session: claim.Session}, Type: loop.InputDelivered, Actor: input.Actor, Cause: input.Cause, Payload: body})
}

// restartClaim stops the current run of a member that cannot take messages mid-run; the claim then starts again
// in the same session and workspace with the human's word as its instruction.
func (e *Engine) restartClaim(ctx context.Context, id event.ID, active claimRun, input loop.Input) bool {
	e.mu.Lock()
	for _, queued := range e.claimRestarts[id] {
		if input.Cause != "" && queued.Cause == input.Cause {
			e.mu.Unlock()
			return true
		}
	}
	e.claimRestarts[id] = append(e.claimRestarts[id], input)
	e.mu.Unlock()
	return active.run.Cancel(ctx) == nil
}

func (e *Engine) takeClaimRestart(id event.ID) []loop.Input {
	e.mu.Lock()
	defer e.mu.Unlock()
	inputs := e.claimRestarts[id]
	delete(e.claimRestarts, id)
	return inputs
}
