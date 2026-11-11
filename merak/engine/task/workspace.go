package task

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (p *Pool) BindWorkspace(ctx context.Context, claimID, workspace event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(claimID)
	if !ok {
		return store.ErrNotFound
	}
	if card.Claims[index].Status != ClaimActive && card.Claims[index].Status != ClaimReported || card.Claims[index].Workspace != "" || workspace == "" {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Workspace = workspace
	return p.emit(ctx, Updated, card, event.Actor{Kind: event.ActorAgent, ID: card.Claims[index].Member})
}

func (p *Pool) MarkIntegrated(ctx context.Context, claimID event.ID, head string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(claimID)
	if !ok {
		return store.ErrNotFound
	}
	if card.Claims[index].Status != ClaimReported || head == "" {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Integrated = head
	return p.emit(ctx, Updated, card, p.leaderActor(ctx, card))
}

func (p *Pool) MarkPublished(ctx context.Context, claimID event.ID, ids []event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(claimID)
	if !ok {
		return store.ErrNotFound
	}
	claim := card.Claims[index]
	if card.Workspace != "folder" || claim.Status != ClaimReported || claim.Report == nil || len(ids) != len(claim.Report.Artifacts) || len(ids) == 0 {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Published = append([]event.ID(nil), ids...)
	return p.emit(ctx, Updated, card, p.leaderActor(ctx, card))
}
