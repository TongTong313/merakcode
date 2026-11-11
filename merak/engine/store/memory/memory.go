// Package memory keeps store documents in RAM.
package memory

import (
	"bytes"
	"cmp"
	"context"
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

type Store struct {
	mu      sync.Mutex
	docs    map[[2]string]store.Doc
	streams map[event.Stream][]event.Event
	events  map[event.ID]event.Event
}

func New() *Store {
	return &Store{docs: make(map[[2]string]store.Doc), streams: make(map[event.Stream][]event.Event), events: make(map[event.ID]event.Event)}
}

func (s *Store) Append(ctx context.Context, events []event.Event) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sequences := make(map[event.Stream]uint64)
	ids := make(map[event.ID]bool)
	for _, e := range events {
		seq, ok := sequences[e.Stream]
		if !ok {
			seq = uint64(len(s.streams[e.Stream]))
		}
		_, exists := s.events[e.ID]
		if e.ID == "" || e.Stream == "" || e.Seq != seq+1 || exists || ids[e.ID] {
			return store.ErrSequence
		}
		sequences[e.Stream] = e.Seq
		ids[e.ID] = true
	}
	for _, e := range events {
		e.Payload = bytes.Clone(e.Payload)
		s.streams[e.Stream] = append(s.streams[e.Stream], e)
		s.events[e.ID] = e
	}
	return nil
}

func (s *Store) Read(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []event.Event{}
	for _, e := range s.streams[stream] {
		if e.Seq < from {
			continue
		}
		if limit > 0 && len(result) == limit {
			break
		}
		e.Payload = bytes.Clone(e.Payload)
		result = append(result, e)
	}
	return result, nil
}

func (s *Store) Put(ctx context.Context, doc store.Doc) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := [2]string{doc.Kind, doc.Key}
	if s.docs[key].Rev != doc.Rev {
		return store.ErrConflict
	}
	doc.Rev++
	s.docs[key] = clone(doc)
	return nil
}

func (s *Store) Find(ctx context.Context, q store.Query) ([]event.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []event.Event{}
	filter := event.Filter{Scope: q.Scope, Types: q.Types}
	text := asciiLower(q.Text)
	for _, e := range s.events {
		if !filter.Matches(e) || !q.After.IsZero() && !e.Time.After(q.After) || !q.Before.IsZero() && !e.Time.Before(q.Before) || text != "" && !strings.Contains(asciiLower(string(e.Payload)), text) {
			continue
		}
		e.Payload = bytes.Clone(e.Payload)
		result = append(result, e)
	}
	slices.SortFunc(result, func(a, b event.Event) int {
		if n := a.Time.Compare(b.Time); n != 0 {
			return n
		}
		if n := cmp.Compare(a.Stream, b.Stream); n != 0 {
			return n
		}
		return cmp.Compare(a.Seq, b.Seq)
	})
	if q.Limit > 0 && len(result) > q.Limit {
		result = result[:q.Limit]
	}
	return result, nil
}

func (s *Store) Get(ctx context.Context, id event.ID) (event.Event, error) {
	if err := ctx.Err(); err != nil {
		return event.Event{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.events[id]
	if !ok {
		return event.Event{}, store.ErrNotFound
	}
	e.Payload = bytes.Clone(e.Payload)
	return e, nil
}

func (s *Store) Fetch(ctx context.Context, kind, key string) (store.Doc, error) {
	if err := ctx.Err(); err != nil {
		return store.Doc{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, ok := s.docs[[2]string{kind, key}]
	if !ok {
		return store.Doc{}, store.ErrNotFound
	}
	return clone(doc), nil
}

func clone(doc store.Doc) store.Doc {
	doc.Body = bytes.Clone(doc.Body)
	doc.Meta = maps.Clone(doc.Meta)
	return doc
}

func (s *Store) List(ctx context.Context, kind, prefix string) ([]store.DocMeta, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	result := []store.DocMeta{}
	for _, doc := range s.docs {
		if doc.Kind == kind && strings.HasPrefix(doc.Key, prefix) {
			result = append(result, store.DocMeta{Kind: doc.Kind, Key: doc.Key, Rev: doc.Rev, Meta: maps.Clone(doc.Meta)})
		}
	}
	slices.SortFunc(result, func(a, b store.DocMeta) int { return cmp.Compare(a.Key, b.Key) })
	return result, nil
}

// DeleteStream removes every event of a stream.
func (s *Store) DeleteStream(ctx context.Context, stream event.Stream) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.streams[stream] {
		delete(s.events, e.ID)
	}
	delete(s.streams, stream)
	return nil
}

// Delete removes a document; a missing one is not an error.
func (s *Store) Delete(ctx context.Context, kind, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.docs, [2]string{kind, key})
	return nil
}

// asciiLower folds only ASCII letters, the same way the SQL LIKE of the local store compares.
func asciiLower(text string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, text)
}
