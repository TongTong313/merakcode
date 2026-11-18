package worker

import (
	"context"
	"errors"
	"sync"
)

// LeaderTurn serializes orchestration calls and prevents a finished turn from doing more work.
type LeaderTurn struct {
	mu               sync.Mutex
	calls            chan struct{}
	settled          chan struct{}
	generation       uint64
	active, finished bool
}

func NewLeaderTurn() *LeaderTurn { return &LeaderTurn{calls: make(chan struct{}, 1)} }

func (t *LeaderTurn) Begin() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active {
		return
	}
	t.active, t.finished = true, false
	t.generation++
	t.settled = make(chan struct{})
}

func (t *LeaderTurn) End() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active {
		t.active = false
		close(t.settled)
	}
}

func (t *LeaderTurn) Finish(string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.finished = true
}

func (t *LeaderTurn) Finishing() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.active && t.finished
}

func (t *LeaderTurn) AcceptsInput() bool {
	if t == nil {
		return true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.active && !t.finished
}

func (t *LeaderTurn) WaitInput(ctx context.Context) error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	wait, settled := t.active && t.finished, t.settled
	t.mu.Unlock()
	if !wait {
		return nil
	}
	select {
	case <-settled:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (t *LeaderTurn) Enter(ctx context.Context) (func(), error) {
	t.mu.Lock()
	generation := t.generation
	t.mu.Unlock()
	select {
	case t.calls <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	release := func() { <-t.calls }
	t.mu.Lock()
	allowed := t.active && !t.finished && generation == t.generation
	t.mu.Unlock()
	if !allowed {
		release()
		return nil, errors.New("this leader turn has ended; finish your response and wait for the next event message")
	}
	return release, nil
}
