package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// A task has no Leader of its own: the Leader of its group leads it, whoever that is now.

// leaderOf returns the Leader of the group of a task, or "" when the group cannot be read.
func (p *Pool) leaderOf(ctx context.Context, card Card) event.ID {
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return ""
	}
	return state.Group.Leader
}

func (p *Pool) leads(ctx context.Context, card Card, member event.ID) bool {
	leader := p.leaderOf(ctx, card)
	return leader != "" && leader == member
}

func (p *Pool) leaderActor(ctx context.Context, card Card) event.Actor {
	return event.Actor{Kind: event.ActorAgent, ID: p.leaderOf(ctx, card)}
}
