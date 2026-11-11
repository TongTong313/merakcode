package task

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"sort"
)

type Phase string

const (
	PhasePlanning    Phase = "planning"
	PhaseDoing       Phase = "doing"
	PhaseIntegrating Phase = "integrating"
	PhaseReview      Phase = "review"
	PhaseDone        Phase = "done"
	PhaseStalled     Phase = "stalled"
	PhaseCancelled   Phase = "cancelled"
)

func (p *Pool) SetPhase(ctx context.Context, id event.ID, next Phase, actor event.Actor) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if card.Parent != "" && next != PhaseCancelled || card.Phase == PhaseDone || card.Phase == PhaseCancelled || card.Status == Done || card.Status == Cancelled || next == PhaseDone {
		return ErrState
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return err
	}
	allowed := actor.Kind == event.ActorAgent && actor.ID == state.Group.Leader && next != PhaseCancelled && next != PhaseDone
	if actor.Kind == event.ActorHuman {
		role := group.RoleApprover
		if next == PhaseCancelled {
			role = group.RoleAdmin
		}
		for _, member := range state.Members {
			if member.ID == actor.ID && member.Can(role) {
				allowed = true
			}
		}
	}
	if !allowed {
		return ErrNotMember
	}
	if card.Phase == next {
		return nil
	}
	if next != PhaseCancelled && !phaseTransition(card.Phase, next, card.PreviousPhase) {
		return ErrState
	}
	if next == PhaseIntegrating && !p.phaseReady(card.ID, false) || next == PhaseReview && !p.phaseReady(card.ID, true) {
		return ErrState
	}
	if card.Phase == PhasePlanning && next == PhaseDoing && state.Group.Settings.PlanNeedsApproval {
		if card.PlanPending {
			return nil
		}
		card.PlanPending = true
		return p.emit(ctx, Updated, card, actor)
	}
	if next == PhasePlanning {
		card.PlanPending, card.LastReview = false, nil
	}
	if next == PhaseStalled {
		card.PreviousPhase = card.Phase
		card.PreviousStatus, card.Status = card.Status, Blocked
	} else {
		if card.Phase == PhaseStalled {
			card.Status = card.PreviousStatus
		}
		card.PreviousPhase = ""
		card.PreviousStatus = ""
	}
	card.Phase = next
	if next == PhaseReview {
		card.Status = Review
		if state.Group.Settings.ReviewRequired() {
			card.LastReview = nil
		}
	}
	if next == PhaseCancelled {
		return p.cancelSubtree(ctx, card, actor)
	}
	return p.emit(ctx, PhaseChanged, card, actor)
}

func (p *Pool) cancelSubtree(ctx context.Context, goal Card, actor event.Actor) error {
	var cards []Card
	for _, card := range p.cards {
		ancestor := card
		for ancestor.ID != goal.ID && ancestor.Parent != "" {
			ancestor = p.cards[ancestor.Parent]
		}
		if ancestor.ID == goal.ID && card.Status != Done && card.Status != Cancelled {
			cards = append(cards, clone(card))
		}
	}
	sort.Slice(cards, func(i, j int) bool { return cards[i].ID < cards[j].ID })
	for _, card := range cards {
		card.Status, card.PlanPending = Cancelled, false
		for i := range card.Claims {
			card.Claims[i].Status = ClaimAbandoned
		}
		if card.ID == goal.ID && card.Parent == "" {
			card.Phase, card.PreviousPhase, card.PreviousStatus = PhaseCancelled, "", ""
			if err := p.emit(ctx, PhaseChanged, card, actor); err != nil {
				return err
			}
		}
		if err := p.emit(ctx, Closed, card, actor); err != nil {
			return err
		}
	}
	return nil
}

func (p *Pool) root(card Card) Card {
	for card.Parent != "" {
		card = p.cards[card.Parent]
	}
	return card
}

func (p *Pool) phaseReady(root event.ID, integrated bool) bool {
	count := 0
	for _, card := range p.cards {
		ancestor := card
		for ancestor.Parent != "" {
			ancestor = p.cards[ancestor.Parent]
		}
		if ancestor.ID != root {
			continue
		}
		if card.Status == Cancelled || card.Status == Failed {
			return false
		}
		if integrated && card.ID != root && card.Review && (card.LastReview == nil || card.LastReview.Decision != "approve" || card.LastReview.Phase != PhaseReview) {
			return false
		}
		if len(card.Claims) == 0 {
			parent := false
			for _, child := range p.cards {
				if child.Parent == card.ID {
					parent = true
					break
				}
			}
			if !parent {
				return false
			}
		}
		for _, claim := range card.Claims {
			if claim.Status == ClaimAbandoned {
				continue
			}
			if claim.Status != ClaimReported || claim.Report == nil || claim.Report.Verdict != VerdictDone {
				return false
			}
			if integrated && (card.Workspace == "worktree" && claim.Integrated == "" || card.Workspace == "folder" && len(claim.Report.Artifacts) != len(claim.Published)) {
				return false
			}
			count++
		}
	}
	return count > 0
}

func phaseTransition(from, to, previous Phase) bool {
	if to == PhaseCancelled || to == PhaseStalled {
		return true
	}
	switch from {
	case PhasePlanning:
		return to == PhaseDoing
	case PhaseDoing:
		return to == PhaseIntegrating || to == PhasePlanning
	case PhaseIntegrating:
		return to == PhaseReview || to == PhaseDoing
	case PhaseReview:
		return to == PhaseDone || to == PhaseDoing || to == PhasePlanning
	case PhaseStalled:
		return to == previous
	}
	return false
}
