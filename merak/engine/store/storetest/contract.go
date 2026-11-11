// Package storetest checks the persistence contract against every storage host.
package storetest

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func Run(t *testing.T, open func(*testing.T) store.Store) {
	t.Helper()
	t.Run("stores versioned documents and binary blobs without shared memory", func(t *testing.T) {
		s := open(t)
		ctx := context.Background()
		doc := store.Doc{Kind: "blob", Key: "artifact/a", Body: []byte{0, 255, 1}, Meta: map[string]string{"title": "binary"}}
		if err := s.Put(ctx, doc); err != nil {
			t.Fatal(err)
		}
		doc.Body[0] = 9
		doc.Meta["title"] = "changed"
		got, err := s.Fetch(ctx, doc.Kind, doc.Key)
		want := store.Doc{Kind: "blob", Key: "artifact/a", Rev: 1, Body: []byte{0, 255, 1}, Meta: map[string]string{"title": "binary"}}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("fetch = %#v, %v", got, err)
		}
		if err := s.Put(ctx, doc); !errors.Is(err, store.ErrConflict) {
			t.Fatalf("stale write = %v", err)
		}
		got.Body = []byte("updated")
		if err := s.Put(ctx, got); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(ctx, store.Doc{Kind: "blob", Key: "other"}); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(ctx, store.Doc{Kind: "snapshot", Key: "artifact/a"}); err != nil {
			t.Fatal(err)
		}
		list, err := s.List(ctx, "blob", "artifact/")
		if err != nil || !reflect.DeepEqual(list, []store.DocMeta{{Kind: "blob", Key: "artifact/a", Rev: 2, Meta: map[string]string{"title": "binary"}}}) {
			t.Fatalf("list = %#v, %v", list, err)
		}
		if _, err := s.Fetch(ctx, "blob", "missing"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("missing = %v", err)
		}
	})
	t.Run("finds events by every scope field and retrieves an ID", func(t *testing.T) {
		s := open(t)
		ctx := context.Background()
		first, second, third := fact("one", "session:a", 1), fact("two", "session:a", 2), fact("three", "session:b", 1)
		first.Scope = event.Scope{Group: "g", Task: "t", Session: "a", Turn: "turn"}
		second.Scope.Group = "g"
		third.Scope.Session = "b"
		third.Type = "task.reported"
		third.Time = first.Time.Add(-time.Hour)
		if err := s.Append(ctx, []event.Event{first, second, third}); err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			name  string
			query store.Query
			want  []event.Event
		}{
			{"group", store.Query{Scope: event.Scope{Group: "g"}}, []event.Event{first, second}},
			{"task", store.Query{Scope: event.Scope{Task: "t"}}, []event.Event{first}},
			{"session", store.Query{Scope: event.Scope{Session: "b"}}, []event.Event{third}},
			{"turn", store.Query{Scope: event.Scope{Turn: "turn"}}, []event.Event{first}},
			{"intersection", store.Query{Scope: event.Scope{Group: "g", Session: "b"}}, []event.Event{}},
			{"type", store.Query{Types: []event.Type{"task.reported"}}, []event.Event{third}},
			{"time", store.Query{After: third.Time, Before: second.Time}, []event.Event{first}},
			{"limit", store.Query{Limit: 1}, []event.Event{third}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				got, err := s.Find(ctx, tc.query)
				if err != nil || !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("find = %#v, %v; want %#v", got, err, tc.want)
				}
			})
		}
		got, err := s.Get(ctx, "one")
		if err != nil || !reflect.DeepEqual(got, first) {
			t.Fatalf("get = %#v, %v", got, err)
		}
		if _, err := s.Get(ctx, "missing"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("missing = %v", err)
		}
	})
	t.Run("finds events by a text in their payload, ignoring ASCII case and treating wildcards literally", func(t *testing.T) {
		s := open(t)
		ctx := context.Background()
		plain := fact("plain", "session:a", 1)
		plain.Payload = json.RawMessage(`{"role":"user","parts":[{"text":"Fix the Login page"}]}`)
		percent := fact("percent", "session:a", 2)
		percent.Payload = json.RawMessage(`{"role":"user","parts":[{"text":"100% done_ok"}]}`)
		other := fact("other", "session:b", 1)
		other.Scope.Session = "b"
		other.Payload = json.RawMessage(`{"role":"user","parts":[{"text":"nothing here"}]}`)
		if err := s.Append(ctx, []event.Event{plain, percent, other}); err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			text string
			want []event.ID
		}{
			{"login", []event.ID{"plain"}},
			{"LOGIN PAGE", []event.ID{"plain"}},
			{"100%", []event.ID{"percent"}},
			{"done_ok", []event.ID{"percent"}},
			{"d_ne", nil},
			{"%", []event.ID{"percent"}},
			{"absent", nil},
		} {
			got, err := s.Find(ctx, store.Query{Text: tc.text})
			var ids []event.ID
			for _, e := range got {
				ids = append(ids, e.ID)
			}
			if err != nil || !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("text %q found %v, %v; want %v", tc.text, ids, err, tc.want)
			}
		}
	})
	t.Run("deletes a stream with its events and a document by its key", func(t *testing.T) {
		s := open(t)
		ctx := context.Background()
		keep, drop := fact("keep", "session:keep", 1), fact("drop", "session:drop", 1)
		keep.Scope.Session, drop.Scope.Session = "keep", "drop"
		if err := s.Append(ctx, []event.Event{keep, drop}); err != nil {
			t.Fatal(err)
		}
		if err := s.Put(ctx, store.Doc{Kind: "snapshot", Key: "drop", Body: []byte("{}")}); err != nil {
			t.Fatal(err)
		}
		if err := s.DeleteStream(ctx, "session:drop"); err != nil {
			t.Fatal(err)
		}
		if err := s.Delete(ctx, "snapshot", "drop"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(ctx, "drop"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("a deleted event is still there: %v", err)
		}
		if read, err := s.Read(ctx, "session:drop", 1, 10); err != nil || len(read) != 0 {
			t.Fatalf("a deleted stream reads %v, %v", read, err)
		}
		if _, err := s.Fetch(ctx, "snapshot", "drop"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("a deleted document is still there: %v", err)
		}
		if got, err := s.Get(ctx, "keep"); err != nil || got.ID != "keep" {
			t.Fatalf("another stream was touched: %v", err)
		}
		if err := s.Delete(ctx, "snapshot", "drop"); err != nil {
			t.Fatalf("deleting twice must not fail: %v", err)
		}
		if err := s.Append(ctx, []event.Event{fact("again", "session:drop", 1)}); err != nil {
			t.Fatalf("a deleted stream starts again from 1: %v", err)
		}
	})
	t.Run("appends consecutive events atomically and reads in sequence order", func(t *testing.T) {
		s := open(t)
		ctx := context.Background()
		first := fact("one", "session:a", 1)
		second := fact("two", "session:a", 2)
		if err := s.Append(ctx, []event.Event{first}); err != nil {
			t.Fatal(err)
		}
		for _, batch := range [][]event.Event{
			{fact("gap", "session:a", 3)},
			{fact("repeat", "session:a", 1)},
			{second, fact("later-gap", "session:a", 4)},
			{fact("one", "session:b", 1)},
		} {
			if err := s.Append(ctx, batch); err == nil {
				t.Fatal("invalid append succeeded")
			}
		}
		if err := s.Append(ctx, []event.Event{second}); err != nil {
			t.Fatal(err)
		}
		got, err := s.Read(ctx, "session:a", 1, 10)
		if err != nil || !reflect.DeepEqual(got, []event.Event{first, second}) {
			t.Fatalf("read = %#v, %v", got, err)
		}
		got, err = s.Read(ctx, "session:a", 2, 1)
		if err != nil || !reflect.DeepEqual(got, []event.Event{second}) {
			t.Fatalf("page = %#v, %v", got, err)
		}
	})
}

func fact(id event.ID, stream event.Stream, seq uint64) event.Event {
	return event.Event{ID: id, Stream: stream, Seq: seq, Time: time.Date(2026, 11, 8, 1, 0, int(seq), 0, time.UTC), Type: "message.sent", Scope: event.Scope{Session: "a"}, Actor: event.Actor{Kind: event.ActorHuman}, Payload: json.RawMessage(`{"role":"user","parts":[{"text":"hello"}]}`)}
}
