package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// Buffered retains event appends while the host is disconnected.
type Buffered struct {
	mu      sync.Mutex
	inner   Store
	queue   []event.Event
	limit   int
	wake    chan struct{}
	changes chan struct{}
}

func NewBuffered(inner Store, limit int) *Buffered {
	if limit <= 0 {
		limit = 4096
	}
	return &Buffered{inner: inner, limit: limit, wake: make(chan struct{}), changes: make(chan struct{}, 1)}
}

type BufferState struct {
	Connected bool `json:"connected"`
	Pending   int  `json:"pending"`
	Limit     int  `json:"limit"`
}

func (b *Buffered) State() BufferState {
	b.mu.Lock()
	defer b.mu.Unlock()
	return BufferState{Connected: b.inner != nil, Pending: len(b.queue), Limit: b.limit}
}

func (b *Buffered) Changes() <-chan struct{} { return b.changes }

func (b *Buffered) changed() {
	select {
	case b.changes <- struct{}{}:
	default:
	}
}

func (b *Buffered) Disconnect() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return
	}
	b.inner = nil
	b.changed()
}

func (b *Buffered) Full() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.queue) >= b.limit
}

func (b *Buffered) Wait(ctx context.Context) error {
	for {
		b.mu.Lock()
		ready := b.inner != nil && len(b.queue) == 0
		wake := b.wake
		b.mu.Unlock()
		if ready {
			return nil
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (b *Buffered) Append(ctx context.Context, facts []event.Event) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	for b.inner == nil && len(b.queue)+len(facts) > b.limit {
		if len(facts) > b.limit {
			return ErrUnavailable
		}
		wake := b.wake
		b.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
		}
		b.mu.Lock()
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if b.inner != nil {
		err := b.inner.Append(ctx, facts)
		if !errors.Is(err, ErrUnavailable) {
			return err
		}
		b.inner = nil
		b.changed()
	}
	if len(b.queue)+len(facts) > b.limit {
		b.mu.Unlock()
		err := b.Append(ctx, facts)
		b.mu.Lock()
		return err
	}
	for _, fact := range facts {
		fact.Payload = append([]byte(nil), fact.Payload...)
		b.queue = append(b.queue, fact)
	}
	if len(b.queue) >= b.limit {
		b.changed()
	}
	return nil
}

func (b *Buffered) Reconnect(ctx context.Context, inner Store) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if inner == nil {
		return ErrUnavailable
	}
	for len(b.queue) > 0 {
		fact := b.queue[0]
		durable, err := inner.Get(ctx, fact.ID)
		if err == nil {
			durable.Time, fact.Time = durable.Time.UTC(), fact.Time.UTC()
			saved, savedErr := json.Marshal(durable)
			queued, queuedErr := json.Marshal(fact)
			if savedErr != nil || queuedErr != nil || !bytes.Equal(saved, queued) {
				return ErrConflict
			}
		} else {
			if !errors.Is(err, ErrNotFound) {
				return err
			}
			if err := inner.Append(ctx, b.queue[:1]); err != nil {
				return err
			}
		}
		b.queue = b.queue[1:]
	}
	b.inner = inner
	close(b.wake)
	b.wake = make(chan struct{})
	b.changed()
	return nil
}

func (b *Buffered) Read(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return nil, ErrUnavailable
	}
	return b.inner.Read(ctx, stream, from, limit)
}
func (b *Buffered) Find(ctx context.Context, query Query) ([]event.Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return nil, ErrUnavailable
	}
	return b.inner.Find(ctx, query)
}
func (b *Buffered) Get(ctx context.Context, id event.ID) (event.Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return event.Event{}, ErrUnavailable
	}
	return b.inner.Get(ctx, id)
}
func (b *Buffered) Put(ctx context.Context, doc Doc) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return ErrUnavailable
	}
	return b.inner.Put(ctx, doc)
}
func (b *Buffered) Fetch(ctx context.Context, kind, key string) (Doc, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return Doc{}, ErrUnavailable
	}
	return b.inner.Fetch(ctx, kind, key)
}
func (b *Buffered) List(ctx context.Context, kind, prefix string) ([]DocMeta, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.inner == nil {
		return nil, ErrUnavailable
	}
	return b.inner.List(ctx, kind, prefix)
}
