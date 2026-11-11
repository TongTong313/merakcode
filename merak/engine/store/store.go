// Package store defines the engine's persistence contract.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

type Store interface {
	Append(context.Context, []event.Event) error
	Read(context.Context, event.Stream, uint64, int) ([]event.Event, error)
	Find(context.Context, Query) ([]event.Event, error)
	Get(context.Context, event.ID) (event.Event, error)
	Put(context.Context, Doc) error
	Fetch(context.Context, string, string) (Doc, error)
	List(context.Context, string, string) ([]DocMeta, error)
	// DeleteStream removes every event of a stream; the stream may start again from sequence 1.
	DeleteStream(context.Context, event.Stream) error
	// Delete removes a document; deleting a missing one succeeds.
	Delete(ctx context.Context, kind, key string) error
}

// Query combines all non-empty fields; time bounds are exclusive and results
// are ordered by time, stream, then sequence. A non-positive limit is unlimited.
type Query struct {
	Scope  event.Scope  `json:"scope,omitempty"`
	Types  []event.Type `json:"types,omitempty"`
	After  time.Time    `json:"after,omitempty"`
	Before time.Time    `json:"before,omitempty"`
	Limit  int          `json:"limit,omitempty"`
	// Text keeps the events whose payload contains it, ignoring ASCII letter case; wildcards are literal.
	Text string `json:"text,omitempty"`
}

type Doc struct {
	Kind string            `json:"kind"`
	Key  string            `json:"key"`
	Rev  uint64            `json:"rev"`
	Body []byte            `json:"body"`
	Meta map[string]string `json:"meta,omitempty"`
}

type DocMeta struct {
	Kind string            `json:"kind"`
	Key  string            `json:"key"`
	Rev  uint64            `json:"rev"`
	Meta map[string]string `json:"meta,omitempty"`
}

var (
	ErrNotFound    = errors.New("store: not found")
	ErrConflict    = errors.New("store: revision conflict")
	ErrSequence    = errors.New("store: invalid event sequence")
	ErrUnavailable = errors.New("store: unavailable")
)
