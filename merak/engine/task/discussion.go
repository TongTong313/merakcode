package task

import (
	"context"
	"errors"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (p *Pool) RecordDiscussion(ctx context.Context, id, reference event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if slices.Contains(card.Discussion, reference) {
		return nil
	}
	fact, err := p.store.Get(ctx, reference)
	if err != nil {
		return err
	}
	if fact.Type != group.HumanSaid || fact.Scope.Group != card.Group || fact.Scope.Task != id {
		return errors.New("discussion reference is outside this task")
	}
	card = clone(card)
	card.Discussion = append(card.Discussion, reference)
	return p.emit(ctx, Updated, card, fact.Actor)
}
