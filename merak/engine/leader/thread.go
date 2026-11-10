package leader

import (
	"context"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

type Priority = group.Priority

const (
	PriorityLow Priority = iota
	PriorityNormal
	PriorityHigh
	PriorityUrgent
)

func priority(fact event.Event) Priority {
	if fact.Actor.Kind == event.ActorHuman && (fact.Type == "human.said" || fact.Type == "task.opened" || fact.Type == "task.closed" || fact.Type == "task.reviewed") {
		return PriorityUrgent
	}
	switch fact.Type {
	case "task.reported", "merge.conflicted", "permission.requested", "permission.routed", "sentinel.flagged":
		return PriorityHigh
	case "file.changed", "repo.changed", "member.status":
		return PriorityLow
	default:
		return PriorityNormal
	}
}

type Scheduler struct {
	mu         sync.Mutex
	queue      []queuedEvent
	ready      chan struct{}
	quietUntil time.Time
	preempt    chan struct{}
	digest     Digest
	admit      func(context.Context) (time.Time, error)
}

type queuedEvent struct {
	event.Event
	priority Priority
	wake     bool
}

func NewScheduler() *Scheduler {
	return &Scheduler{ready: make(chan struct{}, 1), preempt: make(chan struct{}, 1)}
}

func (s *Scheduler) Pending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.queue {
		if item.wake {
			return true
		}
	}
	return false
}
func (s *Scheduler) Enqueue(fact event.Event) {
	s.enqueue(fact, priority(fact), true)
}

func (s *Scheduler) EnqueuePriority(fact event.Event, priority Priority) {
	s.enqueue(fact, priority, true)
}

func (s *Scheduler) Inform(fact event.Event) { s.enqueue(fact, PriorityLow, false) }

// Transfer preserves messages received while a thread's summary is being generated.
func (s *Scheduler) Transfer(next *Scheduler) {
	s.mu.Lock()
	pending := s.queue
	s.queue = nil
	s.mu.Unlock()
	for _, queued := range pending {
		next.enqueue(queued.Event, queued.priority, queued.wake)
	}
}

func (s *Scheduler) enqueue(fact event.Event, level Priority, wake bool) {
	s.mu.Lock()
	if len(s.queue) == 0 {
		s.quietUntil = time.Now().Add(3 * time.Second)
	}
	if fact.Type == "task.progress" {
		for i, previous := range s.queue {
			if previous.Type == fact.Type && previous.Scope.Task == fact.Scope.Task {
				s.queue = append(s.queue[:i], s.queue[i+1:]...)
				break
			}
		}
	}
	s.queue = append(s.queue, queuedEvent{Event: fact, priority: level, wake: wake})
	if level == PriorityUrgent {
		select {
		case s.preempt <- struct{}{}:
		default:
		}
	}
	s.mu.Unlock()
	select {
	case s.ready <- struct{}{}:
	default:
	}
}
func (s *Scheduler) Next(ctx context.Context) (event.Event, error) {
	batch, err := s.wait(ctx, 1)
	if err != nil {
		return event.Event{}, err
	}
	return batch[0], nil
}

func (s *Scheduler) NextBatch(ctx context.Context) ([]event.Event, error) { return s.wait(ctx, 30) }

func (s *Scheduler) SetAdmission(admit func(context.Context) (time.Time, error)) {
	s.mu.Lock()
	s.admit = admit
	s.mu.Unlock()
	s.Signal()
}
func (s *Scheduler) Signal() {
	select {
	case s.ready <- struct{}{}:
	default:
	}
}

func (s *Scheduler) wait(ctx context.Context, limit int) ([]event.Event, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		s.mu.Lock()
		var delay time.Duration
		allowed := true
		wake := false
		for _, queued := range s.queue {
			wake = wake || queued.wake
		}
		if wake && s.queue[s.highest()].priority == PriorityLow {
			delay = time.Until(s.quietUntil)
		}
		if wake && delay <= 0 {
			if s.admit != nil {
				deadline, err := s.admit(ctx)
				if err != nil {
					s.mu.Unlock()
					return nil, err
				}
				if !deadline.IsZero() {
					delay = time.Until(deadline)
				}
				if !deadline.IsZero() {
					allowed = false
					delay = max(delay, time.Millisecond)
				}
			}
		}
		if wake && delay <= 0 && allowed {
			batch := s.take(limit)
			s.mu.Unlock()
			return batch, nil
		}
		s.mu.Unlock()
		var tick <-chan time.Time
		var timer *time.Timer
		if delay > 0 {
			timer = time.NewTimer(delay)
			tick = timer.C
		}
		select {
		case <-s.ready:
		case <-tick:
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return nil, ctx.Err()
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (s *Scheduler) highest() int {
	index := 0
	for i := 1; i < len(s.queue); i++ {
		if s.queue[i].priority > s.queue[index].priority {
			index = i
		}
	}
	return index
}

func (s *Scheduler) take(limit int) []event.Event {
	var batch []event.Event
	for len(s.queue) > 0 && len(batch) < limit {
		index := s.highest()
		batch = append(batch, s.queue[index].Event)
		copy(s.queue[index:], s.queue[index+1:])
		s.queue[len(s.queue)-1] = queuedEvent{}
		s.queue = s.queue[:len(s.queue)-1]
	}
	select {
	case <-s.preempt:
	default:
	}
	if len(s.queue) > 0 && s.queue[s.highest()].priority == PriorityUrgent {
		select {
		case s.preempt <- struct{}{}:
		default:
		}
	}
	return batch
}

func (s *Scheduler) SetDigest(digest Digest)  { s.mu.Lock(); s.digest = digest; s.mu.Unlock() }
func (s *Scheduler) Preempt() <-chan struct{} { return s.preempt }
func (s *Scheduler) Poll() []loop.Input {
	s.mu.Lock()
	batch, digest := s.take(30), s.digest
	s.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	return []loop.Input{digest.Render(batch)}
}

// PollEvents lets an external runtime restore a batch if its process never records it.
func (s *Scheduler) PollEvents() []event.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.take(30)
}

type Thread struct {
	Key       event.ID
	Leader    event.ID
	Session   *session.State
	Scheduler *Scheduler
	Handover  string
}

const (
	ThreadStarted    event.Type = "thread.started"
	ThreadHandedOver event.Type = "thread.handed_over"
)

type Handover struct {
	Key      event.ID `json:"key"`
	Leader   event.ID `json:"leader"`
	Previous event.ID `json:"previous,omitempty"`
	Session  event.ID `json:"session"`
	Summary  string   `json:"summary,omitempty"`
}

func init() {
	event.Register[Handover](ThreadStarted)
	event.Register[Handover](ThreadHandedOver)
}

type Threads struct {
	mu    sync.Mutex
	group group.Group
	state *State
	newID func() event.ID
	items map[event.ID]*Thread
}

func (t *Threads) Wake() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, thread := range t.items {
		thread.Scheduler.Signal()
	}
}

func (t *Threads) List() []*Thread {
	t.mu.Lock()
	defer t.mu.Unlock()
	threads := make([]*Thread, 0, len(t.items))
	for _, thread := range t.items {
		threads = append(threads, thread)
	}
	return threads
}

func NewThreads(g group.Group, state *State, newID func() event.ID) *Threads {
	return &Threads{group: g, state: state, newID: newID, items: map[event.ID]*Thread{}}
}

func (t *Threads) UpdateGroup(g group.Group) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.group = g
}

// Restore reuses the latest durable thread identity without scheduling a model call.
func (t *Threads) Restore(saved Handover, scope event.Scope) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if previous := t.items[saved.Key]; previous != nil && previous.Session.ID == saved.Session && saved.Summary == "" {
		saved.Summary = previous.Handover
	}
	t.items[saved.Key] = &Thread{Key: saved.Key, Leader: saved.Leader, Session: &session.State{ID: saved.Session, Scope: scope, Config: session.Config{Member: saved.Leader}}, Scheduler: NewScheduler(), Handover: saved.Summary}
}
func (t *Threads) Route(fact event.Event) *Thread {
	t.mu.Lock()
	defer t.mu.Unlock()
	if fact.Scope.Group != t.group.ID {
		return nil
	}
	key, member := t.group.ID, t.group.DefaultLeader
	scope := event.Scope{Group: t.group.ID}
	if fact.Scope.Task != "" {
		key = t.state.Root(fact.Scope.Task)
		scope.Task = key
		t.state.mu.Lock()
		for _, line := range t.state.Tasks {
			if line.ID == key && line.Leader != "" {
				member = line.Leader
				break
			}
		}
		t.state.mu.Unlock()
	}
	if thread := t.items[key]; thread != nil {
		return thread
	}
	thread := &Thread{Key: key, Leader: member, Session: &session.State{ID: t.newID(), Scope: scope, Config: session.Config{Member: member}}, Scheduler: NewScheduler()}
	t.items[key] = thread
	return thread
}

// HandOver installs the successor after the engine has stopped and summarized the old session.
func (t *Threads) HandOver(ctx context.Context, old *Thread, member event.ID, summary string) (*Thread, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	thread := &Thread{Key: old.Key, Leader: member, Session: &session.State{ID: t.newID(), Scope: old.Session.Scope, Config: session.Config{Member: member}}, Scheduler: NewScheduler(), Handover: summary}
	t.items[old.Key] = thread
	return thread, nil
}
