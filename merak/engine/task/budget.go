package task

import (
	"context"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"math"
	"time"
)

func (b BudgetIncrease) Validate() error {
	if b.Tokens < 0 || b.Cost < 0 || math.IsNaN(b.Cost) || math.IsInf(b.Cost, 0) || b.WallClock < 0 || b == (BudgetIncrease{}) {
		return errors.New("budget increase must contain a positive finite amount")
	}
	return nil
}

func (p *Pool) increaseBudget(ctx context.Context, id event.ID, delta BudgetIncrease, actor event.Actor) error {
	if err := delta.Validate(); err != nil {
		return err
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
	if card.Status == Done || card.Status == Cancelled || card.Status == Failed {
		return ErrState
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	owner := false
	for _, member := range state.Members {
		if actor.Kind == event.ActorHuman && member.ID == actor.ID && member.Can(group.RoleOwner) {
			owner = true
		}
	}
	if !owner {
		return ErrNotMember
	}
	card = clone(card)
	card.Grants = append(card.Grants, Grant{BudgetIncrease: delta, By: actor, At: time.Now()})
	if card.Status == Blocked {
		card.Status, card.PreviousStatus = card.PreviousStatus, ""
		if card.Phase == PhaseStalled {
			card.Phase, card.PreviousPhase = card.PreviousPhase, ""
		}
	}
	return p.emit(ctx, Updated, card, actor)
}
