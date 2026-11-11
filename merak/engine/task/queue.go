package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (p *Pool) Withdraw(ctx context.Context, id, leader event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(id)
	if !ok {
		return store.ErrNotFound
	}
	if !p.leads(ctx, card, leader) || card.Claims[index].Status != ClaimQueued {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Status = ClaimAbandoned
	card.Status = claimStatus(card.Claims)
	return p.emit(ctx, Updated, card, event.Actor{Kind: event.ActorAgent, ID: leader})
}

func (p *Pool) SetPriority(ctx context.Context, id, leader event.ID, priority int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if !p.leads(ctx, card, leader) || card.Status != Open && card.Status != Queued && card.Status != Running {
		return ErrState
	}
	card.Priority = priority
	return p.emit(ctx, Updated, card, event.Actor{Kind: event.ActorAgent, ID: leader})
}
