package coordinator

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/collab/execution"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) forwardHuman(ctx context.Context, g *groupRun, fact event.Event) bool {
	message, err := event.Decode[group.Message](fact)
	if err != nil || len(message.To) == 0 && fact.Scope.Task == "" {
		return false
	}
	cards, err := domain.tasks.List(ctx, g.group.ID)
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
			if !domain.sendClaimInput(ctx, g.group.ID, claim, loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: domain.humanWord(ctx, g.group.ID, fact.Actor, message.Text)}}}) {
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
		member, err := domain.roster.GroupMember(ctx, g.group.ID, id)
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
		_, err = domain.CreateAssignedTask(ctx, task.Card{Group: g.group.ID, Title: task.TitleFrom(message.Text), Description: message.Text, CreatedBy: fact.Actor}, id)
		if err != nil {
			return false
		}
		forwarded = true
	}
	if !forwarded && len(message.To) == 0 && fact.Scope.Task != "" {
		return domain.tasks.RecordDiscussion(ctx, fact.Scope.Task, fact.ID) == nil
	}
	return forwarded
}

// humanWord wraps a human's message for a member: the human's word overrides the Leader's instructions.
func (domain *Coordinator) humanWord(ctx context.Context, groupID event.ID, actor event.Actor, text string) string {
	name := string(actor.ID)
	if member, err := domain.roster.GroupMember(ctx, groupID, actor.ID); err == nil && member.Name != "" {
		name = member.Name
	}
	return "Message from " + name + " (a human; this overrides the Leader's instructions): " + text
}

func (domain *Coordinator) sendClaimInput(ctx context.Context, groupID event.ID, claim task.Claim, input loop.Input) bool {
	active, running := domain.execution.Claim(claim.ID)
	human := input.Actor.Kind == event.ActorHuman
	if !running {
		member, err := domain.roster.GroupMember(ctx, groupID, claim.Member)
		if err != nil {
			return false
		}
		p, err := domain.roster.MemberAgent(ctx, member)
		if err != nil || !human && !domain.runnerFor(p, nil).Caps().Steer {
			return false
		}
		var queued bool
		active, running, queued = domain.execution.QueuePreparingInput(claim.ID, input)
		if queued {
			domain.receiptInput(ctx, groupID, claim, input)
			return true
		}
	}
	if !running {
		return false
	}
	if input.Cause != "" && slices.Contains(active.Sources, input.Cause) {
		return true
	}
	if !active.Caps.Steer {
		if !human {
			return false
		}
		domain.receiptInput(ctx, groupID, claim, input)
		return domain.restartClaim(ctx, claim.ID, active, input)
	}
	domain.receiptInput(ctx, groupID, claim, input)
	return active.Run.Send(ctx, input) == nil
}

// receiptInput tells every client that an input reached a running member; loop.InputConsumed follows when
// the model reads it.
func (domain *Coordinator) receiptInput(ctx context.Context, groupID event.ID, claim task.Claim, input loop.Input) {
	body, err := json.Marshal(loop.Delivered{Claim: claim.ID})
	if err != nil {
		return
	}
	_, _ = domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID, Task: claim.Task, Session: claim.Session}, Type: loop.InputDelivered, Actor: input.Actor, Cause: input.Cause, Payload: body})
}

// restartClaim stops the current run of a member that cannot take messages mid-run; the claim then starts again
// in the same session and workspace with the human's word as its instruction.
func (domain *Coordinator) restartClaim(ctx context.Context, id event.ID, active execution.ClaimRun, input loop.Input) bool {
	domain.mu.Lock()
	for _, queued := range domain.claimRestarts[id] {
		if input.Cause != "" && queued.Cause == input.Cause {
			domain.mu.Unlock()
			return true
		}
	}
	domain.claimRestarts[id] = append(domain.claimRestarts[id], input)
	domain.mu.Unlock()
	return active.Run.Cancel(ctx) == nil
}

func (domain *Coordinator) takeClaimRestart(id event.ID) []loop.Input {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	inputs := domain.claimRestarts[id]
	delete(domain.claimRestarts, id)
	return inputs
}
