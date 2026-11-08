package task

import (
	"context"
	"sort"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type Update struct {
	Leader event.ID `json:"leader,omitempty"`
	Phase  Phase    `json:"phase,omitempty"`
}

func (p *Pool) Update(ctx context.Context, id event.ID, update Update, actor event.Actor) error {
	if update.Phase != "" {
		if update.Leader != "" {
			return ErrState
		}
		return p.SetPhase(ctx, id, update.Phase, actor)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if card.Parent != "" || card.Status == Done || card.Status == Cancelled || card.Status == Failed || update.Leader == "" {
		return ErrState
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	allowed := actor.Kind == event.ActorAgent && actor.ID == state.Group.DefaultLeader
	valid := false
	for _, member := range state.Members {
		if actor.Kind == event.ActorHuman && member.ID == actor.ID && member.Can(group.RoleAdmin) {
			allowed = true
		}
		if member.ID == update.Leader && member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader {
			valid = true
		}
	}
	if !allowed || !valid {
		return ErrNotMember
	}
	if card.Leader == update.Leader {
		return nil
	}
	var descendants []Card
	for _, child := range p.cards {
		if child.ID != id && p.root(child).ID == id {
			descendants = append(descendants, child)
		}
	}
	sort.Slice(descendants, func(i, j int) bool { return descendants[i].ID < descendants[j].ID })
	for _, changed := range append(descendants, card) {
		changed.Leader = update.Leader
		if err := p.emit(ctx, Updated, changed, actor); err != nil {
			return err
		}
	}
	return nil
}
