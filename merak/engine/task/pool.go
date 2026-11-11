package task

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

var (
	ErrNotMember = errors.New("task: only a worker member can be assigned")
	ErrBusy      = errors.New("task: member already has an active claim")
	ErrState     = errors.New("task: operation is not allowed in the current state")
	// ErrAlreadyBound means the task has a group, which it keeps for good.
	ErrAlreadyBound = errors.New("task: the task already belongs to a group")
	// ErrNotFinished means only a finished task can be archived.
	ErrNotFinished = errors.New("task: only a finished task can be archived")
)

type Pool struct {
	AuthorizeAssignment func(context.Context, group.Member, event.Actor) error
	mu                  sync.Mutex
	store               store.Store
	bus                 *event.Bus
	newID               func() event.ID
	groups              *group.Manager
	loaded              bool
	cards               map[event.ID]Card
	causes              map[event.ID]event.ID
	closedAt            map[event.ID]time.Time
	queue               []event.ID
}

func New(storage store.Store, bus *event.Bus, newID func() event.ID, groups *group.Manager) *Pool {
	return &Pool{store: storage, bus: bus, newID: newID, groups: groups, cards: map[event.ID]Card{}, causes: map[event.ID]event.ID{}, closedAt: map[event.ID]time.Time{}}
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
	// A task keeps its group for good. When history is read back, the events a task wrote in its own stream before a
	// group took it may sort after the ones in the stream of the group, so they must not take the group away.
	if previous, ok := p.cards[card.ID]; ok && previous.Group != "" && card.Group == "" {
		return
	}
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
	if fact.Type == Closed {
		p.closedAt[card.ID] = fact.Time
	}
}

// Observe refreshes the projection after its host's fact has been persisted.
func (p *Pool) Observe(ctx context.Context, fact event.Event) error {
	if !slices.Contains(kinds, fact.Type) {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	card, err := event.Decode[Card](fact)
	if err != nil {
		return err
	}
	if card.ID != fact.Scope.Task || card.Group != fact.Scope.Group {
		return ErrState
	}
	p.apply(fact, card)
	return nil
}

func (p *Pool) emit(ctx context.Context, kind event.Type, card Card, actor event.Actor) error {
	body, err := json.Marshal(card)
	if err != nil {
		return err
	}
	fact, err := p.bus.Publish(ctx, event.Event{Stream: streamOf(card), Scope: event.Scope{Group: card.Group, Task: card.ID}, Actor: actor, Type: kind, Cause: p.causes[card.ID], Payload: body})
	if err != nil {
		return err
	}
	p.apply(fact, clone(card))
	return nil
}

// streamOf names the stream of a card: the one of its group, or its own until a group takes it.
func streamOf(card Card) event.Stream {
	if card.Group == "" {
		return event.Stream("task:" + card.ID)
	}
	return event.Stream("group:" + card.Group)
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
	if card.Group == "" {
		if strings.TrimSpace(card.Project) == "" || card.Parent != "" {
			return Card{}, errors.New("a task without a group needs a project and cannot be a subtask")
		}
	} else {
		state, err := p.groups.Get(ctx, card.Group)
		if err != nil {
			return Card{}, err
		}
		card.Project = state.Group.Project.Directory
	}
	if strings.TrimSpace(card.Title) == "" {
		return Card{}, errors.New("task title is required")
	}
	if card.Budget.MaxSteps < 0 || card.Budget.MaxWallClock < 0 || card.Budget.MaxTokens < 0 || card.Budget.MaxCost < 0 || math.IsNaN(card.Budget.MaxCost) || math.IsInf(card.Budget.MaxCost, 0) || len(card.Grants) > 0 {
		return Card{}, errors.New("task budget must be finite and nonnegative")
	}
	if card.ID == "" {
		card.ID = p.newID()
	}
	if _, exists := p.cards[card.ID]; exists {
		return Card{}, store.ErrConflict
	}
	if card.Parent != "" {
		parent, ok := p.cards[card.Parent]
		if !ok || parent.Group != card.Group {
			return Card{}, store.ErrNotFound
		}
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
	if card.Group != "" {
		if err := p.emit(ctx, Bound, card, card.CreatedBy); err != nil {
			return Card{}, err
		}
	}
	return clone(card), nil
}

// Bind gives a task that no group has taken to a group. From then on its events are written in the stream of the
// group, and the group's Leader receives the task as if it had just been opened there.
func (p *Pool) Bind(ctx context.Context, id, groupID event.ID, kind, base string, actor event.Actor) (Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return Card{}, err
	}
	card, ok := p.cards[id]
	if !ok {
		return Card{}, store.ErrNotFound
	}
	if card.Group != "" {
		return Card{}, ErrAlreadyBound
	}
	state, err := p.groups.Get(ctx, groupID)
	if err != nil {
		return Card{}, err
	}
	card.Group, card.Project = groupID, state.Group.Project.Directory
	if card.Workspace == "" {
		card.Workspace, card.Base = kind, base
	}
	if err := p.emit(ctx, Bound, card, actor); err != nil {
		return Card{}, err
	}
	if card.Status == Open {
		if err := p.emit(ctx, Opened, card, card.CreatedBy); err != nil {
			return Card{}, err
		}
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
	if actor.Kind == "" {
		actor = event.Actor{Kind: event.ActorAgent, ID: state.Group.Leader}
		if publish {
			actor = card.CreatedBy
		}
	}
	worker := false
	for _, member := range state.Members {
		if member.ID == memberID && member.Kind == group.MemberAgent && member.AgentRole == group.AgentWorker {
			if p.AuthorizeAssignment != nil {
				if err := p.AuthorizeAssignment(ctx, member, actor); err != nil {
					return Claim{}, err
				}
			}
			if member.Remote && card.Workspace != "none" && (card.Workspace != "worktree" || state.Group.Project.Remote == "" || member.Checkouts[state.Group.Project.Remote] == "") {
				return Claim{}, errors.New("MRK-6001: remote member requires a matching checkout for worktree tasks")
			}
			worker = true
		}
	}
	if !worker {
		return Claim{}, ErrNotMember
	}
	if (card.Status == Review || card.Status == Queued || card.Status == Running) && len(card.Grants) > 0 {
		for i, previous := range card.Claims {
			if previous.Member != memberID || previous.Role != role || previous.Status != ClaimReported || previous.Report == nil || previous.Report.Verdict != VerdictBlocked {
				continue
			}
			if len(scope) > 0 && !slices.Equal(scope, previous.Scope) {
				return Claim{}, ErrState
			}
			card = clone(card)
			card.Claims[i].Status, card.Claims[i].Report, card.Claims[i].Feedback = ClaimQueued, nil, "Continue the task within the owner-approved budget."
			card.Status = claimStatus(card.Claims)
			if err := p.emit(ctx, Updated, card, actor); err != nil {
				return Claim{}, err
			}
			return card.Claims[i], nil
		}
	}
	if (card.Status == Review || card.Status == Queued || card.Status == Running) && len(card.Grants) > 0 && role == RoleOwner {
		for i, previous := range card.Claims {
			if previous.Role != RoleOwner || previous.Status != ClaimReported || previous.Report == nil || previous.Report.Verdict != VerdictBlocked {
				continue
			}
			card = clone(card)
			card.Claims[i].Status = ClaimAbandoned
			card.Status = claimStatus(card.Claims)
			if card.Status == Review {
				card.Status = Open
			}
			break
		}
	}
	allowed := card.Status == Open || card.Status == Queued || card.Status == Running
	if publish {
		allowed = card.Status == Draft
	}
	if !allowed || role != RoleOwner && role != RoleCollaborator {
		return Claim{}, ErrState
	}
	claimed := slices.ContainsFunc(card.Claims, func(c Claim) bool { return c.Role == RoleOwner && c.Status != ClaimAbandoned })
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
		if !ok || card.Status == Blocked || card.Claims[index].Member != member || card.Claims[index].Status != ClaimQueued {
			continue
		}
		goal := p.root(card)
		state, err := p.groups.Get(ctx, card.Group)
		if err != nil {
			return Claim{}, err
		}
		if state.IsPaused(goal.ID) {
			continue
		}
		if goal.Phase == PhaseStalled || goal.Phase == PhaseCancelled || goal.Phase == PhaseDone {
			continue
		}
		if goal.Phase == PhasePlanning {
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
	if card.Status == Blocked {
		card.PreviousStatus = claimStatus(card.Claims)
	} else {
		card.Status = claimStatus(card.Claims)
	}
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
		if err := p.emit(ctx, PhaseChanged, card, p.leaderActor(ctx, card)); err != nil {
			return err
		}
	}
	return p.emit(ctx, Closed, card, p.leaderActor(ctx, card))
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

// Retarget points the unfinished tasks of a group at another workspace. Tasks that were based on a commit of the
// former one take the given base. It fails when a task of the group still has running or queued work.
func (p *Pool) Retarget(ctx context.Context, groupID event.ID, directory, base string, actor event.Actor) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return err
	}
	ids := []event.ID{}
	for id, card := range p.cards {
		if card.Group == groupID && !card.Finished() {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	for _, id := range ids {
		card := clone(p.cards[id])
		card.Project = directory
		if card.Workspace == "worktree" {
			card.Base = base
		}
		if err := p.emit(ctx, Updated, card, actor); err != nil {
			return err
		}
	}
	return nil
}

// Working says whether a task of the group has a claim that is running or waiting to run.
func (p *Pool) Working(ctx context.Context, groupID event.ID) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return false, err
	}
	for _, card := range p.cards {
		if card.Group != groupID {
			continue
		}
		for _, claim := range card.Claims {
			if claim.Status == ClaimActive || claim.Status == ClaimQueued {
				return true, nil
			}
		}
	}
	return false, nil
}

// Filter picks tasks across every group, and the ones no group has taken.
type Filter struct {
	// Project keeps the tasks of one workspace folder.
	Project string
	// Archived asks for the archived tasks instead of the visible ones.
	Archived bool
}

// Find lists the tasks that match the filter, oldest first.
func (p *Pool) Find(ctx context.Context, filter Filter) ([]Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	result := []Card{}
	for _, card := range p.cards {
		if card.Archived == filter.Archived && (filter.Project == "" || card.Project == filter.Project) {
			result = append(result, clone(card))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

// Archive hides finished tasks from the board, or brings them back. The whole batch is refused when archiving one
// that has not finished.
func (p *Pool) Archive(ctx context.Context, ids []event.ID, archived bool, actor event.Actor) ([]Card, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	for _, id := range ids {
		card, ok := p.cards[id]
		if !ok {
			return nil, store.ErrNotFound
		}
		if archived && !card.Finished() {
			return nil, ErrNotFinished
		}
	}
	result := []Card{}
	for _, id := range ids {
		card := clone(p.cards[id])
		if card.Archived == archived {
			result = append(result, card)
			continue
		}
		card.Archived = archived
		if err := p.emit(ctx, ArchivedEvent, card, actor); err != nil {
			return nil, err
		}
		result = append(result, card)
	}
	return result, nil
}

// FinishedBefore lists the visible tasks that ended at or before the given time.
func (p *Pool) FinishedBefore(ctx context.Context, limit time.Time) ([]event.ID, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.load(ctx); err != nil {
		return nil, err
	}
	result := []event.ID{}
	for id, card := range p.cards {
		if !card.Archived && card.Finished() && !p.closedAt[id].After(limit) {
			result = append(result, id)
		}
	}
	slices.Sort(result)
	return result, nil
}
