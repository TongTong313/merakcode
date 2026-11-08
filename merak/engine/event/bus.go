package event

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

type Sink interface {
	Append(context.Context, []Event) error
}

type Bus struct {
	mu          sync.Mutex
	sink        Sink
	now         func() time.Time
	newID       func() ID
	sequences   map[Stream]uint64
	subscribers map[chan Event]Filter
}

func NewBus(sink Sink, now func() time.Time, newID func() ID) *Bus {
	return &Bus{
		sink: sink, now: now, newID: newID,
		sequences: make(map[Stream]uint64), subscribers: make(map[chan Event]Filter),
	}
}

func (b *Bus) Publish(ctx context.Context, e Event) (Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Event{}, err
	}
	e.ID = b.newID()
	e.Time = b.now()
	e.Seq = 0
	if !Transient(e.Type) {
		e.Seq = b.sequences[e.Stream] + 1
		if b.sink != nil {
			if err := b.sink.Append(ctx, []Event{e}); err != nil {
				return Event{}, err
			}
		}
		b.sequences[e.Stream] = e.Seq
	}
	for ch, filter := range b.subscribers {
		if !filter.Matches(e) {
			continue
		}
		select {
		case ch <- e:
		default:
		drain:
			for {
				select {
				case <-ch:
				default:
					break drain
				}
			}
			ch <- Event{ID: b.newID(), Time: b.now(), Type: Lagged, Payload: json.RawMessage(`{}`)}
			close(ch)
			delete(b.subscribers, ch)
		}
	}
	return e, nil
}

func (b *Bus) Subscribe(filter Filter) (<-chan Event, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan Event, 1024)
	b.subscribers[ch] = filter
	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.subscribers[ch]; ok {
			delete(b.subscribers, ch)
			close(ch)
		}
	}
}

// Resume restores a stream's durable position before publishing more facts.
func (b *Bus) Resume(stream Stream, seq uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if seq > b.sequences[stream] {
		b.sequences[stream] = seq
	}
}
