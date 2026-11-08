package task

import (
	"context"
	"sort"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type ReviewResult struct {
	Phase    Phase    `json:"phase,omitempty"`
	Human    event.ID `json:"human"`
	Decision string   `json:"decision"`
	Feedback string   `json:"feedback,omitempty"`
}

func (p *Pool) Review(ctx context.Context, id event.ID, review ReviewResult) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	plan := card.Parent == "" && card.Phase == PhasePlanning && card.PlanPending
	goal := card.Parent == "" && card.Phase == PhaseReview
	if (!plan && card.Status != Review) || review.Decision != "approve" && review.Decision != "rework" && !((plan || goal) && review.Decision == "replan") || review.Decision != "approve" && strings.TrimSpace(review.Feedback) == "" {
		return ErrState
	}
	if review.Decision == "rework" && card.LastReview != nil && card.LastReview.Decision == "approve" {
		return ErrState
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	human := false
	for _, member := range state.Members {
		if member.ID == review.Human && member.Can(group.RoleApprover) {
			human = true
		}
	}
	if !human {
		return ErrNotMember
	}
	card = clone(card)
	if plan {
		review.Phase = PhasePlanning
		card.LastReview, card.PlanPending = &review, false
		if review.Decision == "approve" {
			card.Phase = PhaseDoing
		}
		actor := event.Actor{Kind: event.ActorHuman, ID: review.Human}
		if err := p.emit(ctx, Reviewed, card, actor); err != nil {
			return err
		}
		if review.Decision == "approve" {
			return p.emit(ctx, PhaseChanged, card, actor)
		}
		return nil
	}
	review.Phase = PhaseReview
	card.LastReview = &review
	if goal && review.Decision != "approve" {
		return p.reviewGoal(ctx, card, review)
	}
	if review.Decision == "rework" {
		for i := range card.Claims {
			claim := &card.Claims[i]
			if claim.Status == ClaimAbandoned {
				continue
			}
			if claim.Status != ClaimReported || claim.Integrated != "" {
				return ErrState
			}
			claim.Status, claim.Report, claim.Integrated = ClaimQueued, nil, ""
			claim.Published = nil
		}
		card.Status = Queued
	}
	return p.emit(ctx, Reviewed, card, event.Actor{Kind: event.ActorHuman, ID: review.Human})
}

func (p *Pool) reviewGoal(ctx context.Context, card Card, review ReviewResult) error {
	actor := event.Actor{Kind: event.ActorHuman, ID: review.Human}
	if review.Decision == "replan" {
		card.Phase, card.Status = PhasePlanning, Open
		if err := p.emit(ctx, Reviewed, card, actor); err != nil {
			return err
		}
		return p.emit(ctx, PhaseChanged, card, actor)
	}
	var changed []Card
	for _, candidate := range p.cards {
		ancestor := candidate
		for ancestor.Parent != "" {
			ancestor = p.cards[ancestor.Parent]
		}
		if ancestor.ID != card.ID {
			continue
		}
		candidate = clone(candidate)
		for i := range candidate.Claims {
			claim := &candidate.Claims[i]
			if claim.Status == ClaimAbandoned {
				continue
			}
			if claim.Status != ClaimReported {
				return ErrState
			}
			claim.Status, claim.Report, claim.Integrated, claim.Published, claim.Feedback = ClaimQueued, nil, "", nil, review.Feedback
		}
		candidate.Status, candidate.LastReview = claimStatus(candidate.Claims), &review
		if candidate.ID == card.ID {
			candidate.Phase = PhaseDoing
		}
		changed = append(changed, candidate)
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].ID < changed[j].ID })
	for _, candidate := range changed {
		if err := p.emit(ctx, Reviewed, candidate, actor); err != nil {
			return err
		}
		if candidate.ID == card.ID {
			if err := p.emit(ctx, PhaseChanged, candidate, actor); err != nil {
				return err
			}
		}
	}
	return nil
}
