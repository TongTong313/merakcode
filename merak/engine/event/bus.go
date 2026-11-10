package event

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type Sink interface {
	Append(context.Context, []Event) error
}

type Bus struct {
	Route       func(Event) Stream
	mu          sync.Mutex
	sink        Sink
	now         func() time.Time
	newID       func() ID
	sequences   map[Stream]uint64
	subscribers map[chan Event]Filter
	redactions  map[deltaKey]*deltaRedaction
}

func NewBus(sink Sink, now func() time.Time, newID func() ID) *Bus {
	return &Bus{
		sink: sink, now: now, newID: newID,
		sequences: make(map[Stream]uint64), subscribers: make(map[chan Event]Filter),
		redactions: make(map[deltaKey]*deltaRedaction),
	}
}

func (b *Bus) Publish(ctx context.Context, e Event) (Event, error) {
	clean, err := secret.RedactJSON(e.Payload)
	if err != nil {
		return Event{}, err
	}
	e.Payload = clean
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return Event{}, err
	}
	e.ID = b.newID()
	if b.Route != nil {
		e.Stream = b.Route(e)
	}
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
	if err := b.redactDelta(&e); err != nil {
		return Event{}, err
	}
	b.deliver(e)
	return e, nil
}

// Import retains the identity and ordering assigned by a remote stream owner.
func (b *Bus) Import(ctx context.Context, e Event) error {
	clean, err := secret.RedactJSON(e.Payload)
	if err != nil {
		return err
	}
	e.Payload = clean
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.ID == "" || e.Stream == "" {
		return errors.New("event identity is required")
	}
	if !Transient(e.Type) {
		if e.Seq != b.sequences[e.Stream]+1 {
			return errors.New("remote event sequence gap")
		}
		if b.sink != nil {
			if err := b.sink.Append(ctx, []Event{e}); err != nil {
				return err
			}
		}
		b.sequences[e.Stream] = e.Seq
	}
	if err := b.redactDelta(&e); err != nil {
		return err
	}
	b.deliver(e)
	return nil
}

func (b *Bus) deliver(e Event) {
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

func (b *Bus) Position(stream Stream) uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sequences[stream]
}
