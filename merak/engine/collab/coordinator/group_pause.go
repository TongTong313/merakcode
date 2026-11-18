package coordinator

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) controlGroupClaims(ctx context.Context, run *groupRun, fact event.Event, thread event.ID) {
	cards, err := domain.tasks.List(ctx, run.group.ID)
	if err != nil {
		return
	}
	for _, card := range cards {
		if thread != "" && thread != run.group.ID {
			root, err := domain.roster.TaskRoot(ctx, card)
			if err != nil || root != thread {
				continue
			}
		}
		for _, claim := range card.Claims {
			if fact.Type == group.Resumed && claim.Status == task.ClaimQueued {
				domain.startMember(run, claim.Member)
			}
			if fact.Type != group.Paused || claim.Status != task.ClaimActive {
				continue
			}
			active, ok := domain.execution.ClaimToPause(claim.ID)
			if !ok {
				continue
			}
			input := loop.Input{Actor: fact.Actor, Cause: fact.ID, Parts: []model.Part{{Text: "Pause requested. Stop work safely and submit a blocked report describing your current progress."}}}
			if !active.Caps.Steer || active.Run.Send(ctx, input) != nil {
				_ = active.Run.Cancel(ctx)
			}
		}
	}
}
