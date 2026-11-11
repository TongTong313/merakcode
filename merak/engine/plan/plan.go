// Package plan keeps the plan of a conversation: one editable document per root session. A plan is written by the
// agent (or by the person), reviewed, executed from a fixed snapshot and finished or stopped. Plans are not a mode:
// any permission mode can write one.
package plan

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Status is where a plan is in its life.
type Status string

const (
	// Draft is a plan nobody asked for yet; the store never holds one, Get of a missing plan is ErrNone.
	Draft     Status = "draft"
	Review    Status = "review"
	Executing Status = "executing"
	Done      Status = "done"
	Stopped   Status = "stopped"
)

// Updated tells clients that the plan of a session changed.
const Updated event.Type = "plan.updated"

func init() { event.Register[Plan](Updated) }

// Plan is the plan of one root session.
type Plan struct {
	Session event.ID `json:"session"`
	Content string   `json:"content"`
	Status  Status   `json:"status"`
	// Revision counts the changes of the content; an edit must name the revision it started from.
	Revision int `json:"revision"`
	// Snapshot is the content an execution runs from; editing the plan later does not change it.
	Snapshot string `json:"snapshot,omitempty"`
}

// Run is what execute returns: the plan and the text to send as the execution message.
type Run struct {
	Plan     Plan   `json:"plan"`
	Snapshot string `json:"snapshot"`
}

var (
	// ErrNone says the session has no plan.
	ErrNone = errors.New("plan: this session has no plan")
	// ErrStale says an edit started from an older revision than the plan has now.
	ErrStale = errors.New("plan: the plan changed since it was read")
	// ErrState says the plan is not in a state that allows the operation.
	ErrState = errors.New("plan: not allowed in the current state")
)

const kind = "plan"

// Plans stores plans as documents.
type Plans struct {
	store store.Store
	mu    sync.Mutex
}

// New returns the plans kept in a store.
func New(storage store.Store) *Plans { return &Plans{store: storage} }

func (p *Plans) load(ctx context.Context, session event.ID) (Plan, uint64, error) {
	doc, err := p.store.Fetch(ctx, kind, string(session))
	if errors.Is(err, store.ErrNotFound) {
		return Plan{}, 0, ErrNone
	}
	if err != nil {
		return Plan{}, 0, err
	}
	var value Plan
	return value, doc.Rev, json.Unmarshal(doc.Body, &value)
}

func (p *Plans) put(ctx context.Context, value Plan, rev uint64) (Plan, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return Plan{}, err
	}
	if err := p.store.Put(ctx, store.Doc{Kind: kind, Key: string(value.Session), Rev: rev, Body: body}); err != nil {
		if errors.Is(err, store.ErrConflict) {
			return Plan{}, ErrStale
		}
		return Plan{}, err
	}
	return value, nil
}

// Get returns the plan of a session.
func (p *Plans) Get(ctx context.Context, session event.ID) (Plan, error) {
	value, _, err := p.load(ctx, session)
	return value, err
}

// Write stores a plan the agent wrote and puts it up for review, replacing the one that was there.
func (p *Plans) Write(ctx context.Context, session event.ID, content string) (Plan, error) {
	if strings.TrimSpace(content) == "" {
		return Plan{}, errors.New("a plan needs content")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	previous, rev, err := p.load(ctx, session)
	if err != nil && !errors.Is(err, ErrNone) {
		return Plan{}, err
	}
	return p.put(ctx, Plan{Session: session, Content: content, Status: Review, Revision: previous.Revision + 1}, rev)
}

// Save stores an edit of the plan. The revision is the one the editor read; an older one is refused so that two
// editors never overwrite each other.
func (p *Plans) Save(ctx context.Context, session event.ID, content string, revision int) (Plan, error) {
	if strings.TrimSpace(content) == "" {
		return Plan{}, errors.New("a plan needs content")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	current, rev, err := p.load(ctx, session)
	if err != nil {
		return Plan{}, err
	}
	if current.Revision != revision {
		return Plan{}, ErrStale
	}
	current.Content, current.Revision = content, current.Revision+1
	return p.put(ctx, current, rev)
}

// Execute fixes the current content as the snapshot to run and marks the plan as executing.
func (p *Plans) Execute(ctx context.Context, session event.ID) (Run, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current, rev, err := p.load(ctx, session)
	if err != nil {
		return Run{}, err
	}
	if current.Status != Review && current.Status != Stopped {
		return Run{}, ErrState
	}
	current.Status, current.Snapshot = Executing, current.Content
	saved, err := p.put(ctx, current, rev)
	return Run{Plan: saved, Snapshot: saved.Snapshot}, err
}

func (p *Plans) end(ctx context.Context, session event.ID, status Status) (Plan, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current, rev, err := p.load(ctx, session)
	if err != nil {
		return Plan{}, err
	}
	if current.Status != Executing {
		return Plan{}, ErrState
	}
	current.Status = status
	return p.put(ctx, current, rev)
}

// Finish marks an executing plan as done.
func (p *Plans) Finish(ctx context.Context, session event.ID) (Plan, error) {
	return p.end(ctx, session, Done)
}

// Stop marks an executing plan as stopped.
func (p *Plans) Stop(ctx context.Context, session event.ID) (Plan, error) {
	return p.end(ctx, session, Stopped)
}
