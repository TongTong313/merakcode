package task

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

var (
	ErrNotMember = errors.New("task: only a worker member can be assigned")
	ErrBusy      = errors.New("task: member already has an active claim")
	ErrState     = errors.New("task: operation is not allowed in the current state")
)

type Pool struct {
	mu     sync.Mutex
	store  store.Store
	bus    *event.Bus
	newID  func() event.ID
	groups *group.Manager
	loaded bool
	cards  map[event.ID]Card
	causes map[event.ID]event.ID
	queue  []event.ID
}

func New(storage store.Store, bus *event.Bus, newID func() event.ID, groups *group.Manager) *Pool {
	return &Pool{store: storage, bus: bus, newID: newID, groups: groups, cards: map[event.ID]Card{}, causes: map[event.ID]event.ID{}}
}
func (p *Pool) load(ctx context.Context) error {
	if p.loaded {
		return nil
	}
	facts, err := p.store.Find(ctx, store.Query{Types: kinds})
	if err != nil {
		return err
	}
	for _, fact := range facts {
		card, err := event.Decode[Card](fact)
		if err != nil {
			return err
		}
		p.apply(fact, card)
		p.bus.Resume(fact.Stream, fact.Seq)
	}
	p.loaded = true
	return nil
}
func (p *Pool) apply(fact event.Event, card Card) {
	for _, claim := range card.Claims {
		if claim.Status != ClaimQueued {
			p.queue = slices.DeleteFunc(p.queue, func(id event.ID) bool { return id == claim.ID })
			continue
		}
		if !slices.Contains(p.queue, claim.ID) {
			p.queue = append(p.queue, claim.ID)
		}
	}
	p.cards[card.ID] = card
	p.causes[card.ID] = fact.ID
}
func (p *Pool) emit(ctx context.Context, kind event.Type, card Card, actor event.Actor) error {
	body, err := json.Marshal(card)
	if err != nil {
		return err
	}
	fact, err := p.bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + card.Group), Scope: event.Scope{Group: card.Group, Task: card.ID}, Actor: actor, Type: kind, Cause: p.causes[card.ID], Payload: body})
	if err != nil {
		return err
	}
	p.apply(fact, clone(card))
	return nil
}
func clone(card Card) Card {
	body, _ := json.Marshal(card)
	var copy Card
	_ = json.Unmarshal(body, &copy)
	return copy
}
func (p *Pool) Create(ctx context.Context, card Card) (Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Card{}, err
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return Card{}, err
	}
	if strings.TrimSpace(card.Title) == "" {
		return Card{}, errors.New("task title is required")
	}
	if card.ID == "" {
		card.ID = p.newID()
	}
	if _, exists := p.cards[card.ID]; exists {
		return Card{}, store.ErrConflict
	}
	if card.Leader == "" {
		card.Leader = state.Group.DefaultLeader
	}
	if card.Parent != "" {
		parent, ok := p.cards[card.Parent]
		if !ok || parent.Group != card.Group {
			return Card{}, store.ErrNotFound
		}
		card.Leader = parent.Leader
	}
	leader := false
	for _, member := range state.Members {
		if member.ID == card.Leader && member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader {
			leader = true
		}
	}
	if !leader {
		return Card{}, errors.New("task leader must be a leader member of its group")
	}
	if err := validateAreas(card.Areas); err != nil {
		return Card{}, err
	}
	card.Status, card.Claims = Draft, nil
	card.Phase, card.PreviousPhase = "", ""
	if card.Parent == "" {
		card.Phase = PhasePlanning
	}
	if err := p.emit(ctx, Created, card, card.CreatedBy); err != nil {
		return Card{}, err
	}
	return clone(card), nil
}
func (p *Pool) Open(ctx context.Context, id event.ID) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if card.Status != Draft {
		return ErrState
	}
	card.Status = Open
	return p.emit(ctx, Opened, card, card.CreatedBy)
}
func (p *Pool) Get(ctx context.Context, id event.ID) (Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Card{}, err
	}
	card, ok := p.cards[id]
	if !ok {
		return Card{}, store.ErrNotFound
	}
	return clone(card), nil
}
func (p *Pool) Assign(ctx context.Context, id, memberID event.ID, role ClaimRole, scope []string) (Claim, error) {
	return p.AssignAs(ctx, id, memberID, role, scope, event.Actor{})
}

// AssignAs preserves the actor that initiated a deterministic assignment.
func (p *Pool) AssignAs(ctx context.Context, id, memberID event.ID, role ClaimRole, scope []string, actor event.Actor) (Claim, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Claim{}, err
	}
	return p.assign(ctx, id, memberID, role, scope, false, actor)
}

// OpenAndAssign publishes a human's direct assignment without exposing an unassigned snapshot.
func (p *Pool) OpenAndAssign(ctx context.Context, id, memberID event.ID) (Claim, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Claim{}, err
	}
	return p.assign(ctx, id, memberID, RoleOwner, nil, true, event.Actor{})
}

func (p *Pool) assign(ctx context.Context, id, memberID event.ID, role ClaimRole, scope []string, publish bool, actor event.Actor) (Claim, error) {
	card, ok := p.cards[id]
	if !ok {
		return Claim{}, store.ErrNotFound
	}
	state, err := p.groups.Get(ctx, card.Group)
	if err != nil {
		return Claim{}, err
	}
	worker := false
	for _, member := range state.Members {
		if member.ID == memberID && member.Kind == group.MemberAgent && member.AgentRole == group.AgentWorker {
			worker = true
		}
	}
	if !worker {
		return Claim{}, ErrNotMember
	}
	allowed := card.Status == Open || card.Status == Queued || card.Status == Running
	if publish {
		allowed = card.Status == Draft
	}
	if !allowed || role != RoleOwner && role != RoleCollaborator {
		return Claim{}, ErrState
	}
	claimed := slices.ContainsFunc(card.Claims, func(c Claim) bool { return c.Status != ClaimAbandoned })
	if !claimed && role != RoleOwner || claimed && role != RoleCollaborator {
		return Claim{}, ErrState
	}
	if err := validateScope(card, memberID, scope); err != nil {
		return Claim{}, err
	}
	goal := card
	for goal.Parent != "" {
		goal = p.cards[goal.Parent]
	}
	if goal.Phase == PhaseStalled || goal.Phase == PhaseCancelled || goal.Phase == PhaseDone || goal.Phase == PhasePlanning && state.Group.Settings.PlanNeedsApproval {
		return Claim{}, ErrState
	}
	for _, dependency := range card.Deps {
		if p.cards[dependency].Status != Done || p.cards[dependency].Group != card.Group {
			return Claim{}, ErrState
		}
	}
	if publish {
		card.Status = Open
		if err := p.emit(ctx, Opened, card, card.CreatedBy); err != nil {
			return Claim{}, err
		}
	}
	claim := Claim{ID: p.newID(), Member: memberID, Task: id, Role: role, Scope: append([]string(nil), scope...), Status: ClaimQueued}
	card = clone(card)
	card.Claims = append(card.Claims, claim)
	card.Status = claimStatus(card.Claims)
	if actor.Kind == "" {
		actor = event.Actor{Kind: event.ActorAgent, ID: card.Leader}
		if publish {
			actor = card.CreatedBy
		}
	}
	if err := p.emit(ctx, QueuedEvent, card, actor); err != nil {
		return Claim{}, err
	}
	return claim, nil
}
func (p *Pool) Next(ctx context.Context, member event.ID) (Claim, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Claim{}, err
	}
	for _, card := range p.cards {
		for _, claim := range card.Claims {
			if claim.Member == member && claim.Status == ClaimActive {
				return Claim{}, ErrBusy
			}
		}
	}
	queue := slices.Clone(p.queue)
	sort.SliceStable(queue, func(i, j int) bool {
		first, _, _ := p.claim(queue[i])
		second, _, _ := p.claim(queue[j])
		return first.Priority > second.Priority
	})
	for _, id := range queue {
		card, index, ok := p.claim(id)
		if !ok || card.Claims[index].Member != member || card.Claims[index].Status != ClaimQueued {
			continue
		}
		goal := p.root(card)
		if goal.Phase == PhaseStalled || goal.Phase == PhaseCancelled || goal.Phase == PhaseDone {
			continue
		}
		if goal.Phase == PhasePlanning {
			state, err := p.groups.Get(ctx, card.Group)
			if err != nil {
				return Claim{}, err
			}
			if state.Group.Settings.PlanNeedsApproval {
				continue
			}
		}
		card = clone(card)
		claim := &card.Claims[index]
		claim.Status = ClaimActive
		if claim.Session == "" {
			claim.Session = p.newID()
		}
		card.Status = Running
		if err := p.emit(ctx, Started, card, event.Actor{Kind: event.ActorAgent, ID: member}); err != nil {
			return Claim{}, err
		}
		return *claim, nil
	}
	return Claim{}, store.ErrNotFound
}
func (p *Pool) claim(id event.ID) (Card, int, bool) {
	for _, card := range p.cards {
		for i, claim := range card.Claims {
			if claim.ID == id {
				return card, i, true
			}
		}
	}
	return Card{}, 0, false
}
func (p *Pool) Submit(ctx context.Context, report Report) error {
	if err := report.Validate(); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, index, ok := p.claim(report.Claim)
	if !ok {
		return store.ErrNotFound
	}
	if card.Claims[index].Status != ClaimActive {
		return ErrState
	}
	card = clone(card)
	card.Claims[index].Status, card.Claims[index].Report = ClaimReported, &report
	card.Status = claimStatus(card.Claims)
	return p.emit(ctx, Reported, card, event.Actor{Kind: event.ActorAgent, ID: card.Claims[index].Member})
}
func (p *Pool) Close(ctx context.Context, id event.ID, status Status) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, ok := p.cards[id]
	if !ok {
		return store.ErrNotFound
	}
	if status != Done && status != Failed && status != Cancelled {
		return ErrState
	}
	if status == Done {
		if card.Parent == "" && card.Phase != PhaseReview {
			return ErrState
		}
		if card.Phase == PhaseReview {
			state, err := p.groups.Get(ctx, card.Group)
			if err != nil {
				return err
			}
			if state.Group.Settings.ReviewRequired() && (card.LastReview == nil || card.LastReview.Decision != "approve" || card.LastReview.Phase != PhaseReview) {
				return ErrState
			}
		}
		if card.Review && (card.LastReview == nil || card.LastReview.Decision != "approve" || card.LastReview.Phase == PhasePlanning) {
			return ErrState
		}
		if card.Status != Review && !(card.Status == Open && len(card.Claims) == 0) {
			return ErrState
		}
		children := 0
		for _, child := range p.cards {
			if child.Parent == card.ID {
				children++
				if child.Status != Done {
					return ErrState
				}
			}
		}
		if len(card.Claims) == 0 && children == 0 {
			return ErrState
		}
		for _, claim := range card.Claims {
			if claim.Status == ClaimAbandoned {
				continue
			}
			if claim.Report == nil || claim.Report.Verdict != VerdictDone {
				return ErrState
			}
			if card.Workspace == "worktree" && claim.Integrated == "" {
				return ErrState
			}
			if card.Workspace == "folder" && len(claim.Published) != len(claim.Report.Artifacts) {
				return ErrState
			}
		}
	}
	card.Status = status
	if status == Done && card.Phase == PhaseReview {
		card.Phase = PhaseDone
		if err := p.emit(ctx, PhaseChanged, card, event.Actor{Kind: event.ActorAgent, ID: card.Leader}); err != nil {
			return err
		}
	}
	return p.emit(ctx, Closed, card, event.Actor{Kind: event.ActorAgent, ID: card.Leader})
}

func (p *Pool) List(ctx context.Context, groupID event.ID) ([]Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	result := []Card{}
	for _, card := range p.cards {
		if card.Group == groupID {
			result = append(result, clone(card))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}
