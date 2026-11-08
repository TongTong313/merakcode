package localstore_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
)

func TestGoldenDatabases(t *testing.T) {
	root := "../../../schema/testdata"
	body, err := os.ReadFile(filepath.Join(root, "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Events []event.Event `json:"events"`
		Docs   []store.Doc   `json:"docs"`
	}
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if os.Getenv("MERAK_GENERATE_STORE_GOLDEN") == "1" {
		s, err := localstore.Open(filepath.Join(root, "go.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if err := s.Append(ctx, fixture.Events); err != nil {
			t.Fatal(err)
		}
		for _, doc := range fixture.Docs {
			doc.Rev = 0
			if err := s.Put(ctx, doc); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	for _, name := range []string{"go.db", "typescript.db"} {
		t.Run(name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "merak.db")
			if err := os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
			s, err := localstore.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			events, err := s.Read(ctx, "session:golden", 1, 100)
			if err != nil || len(events) != len(fixture.Events) {
				t.Fatalf("events = %#v, %v", events, err)
			}
			for i, got := range events {
				var actual, expected any
				json.Unmarshal(got.Payload, &actual)
				json.Unmarshal(fixture.Events[i].Payload, &expected)
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("payload = %#v; want %#v", actual, expected)
				}
				got.Payload = fixture.Events[i].Payload
				if !reflect.DeepEqual(got, fixture.Events[i]) {
					t.Fatalf("event = %#v; want %#v", got, fixture.Events[i])
				}
			}
			for _, doc := range fixture.Docs {
				got, err := s.Fetch(ctx, doc.Kind, doc.Key)
				if err != nil || !reflect.DeepEqual(got, doc) {
					t.Fatalf("doc = %#v, %v", got, err)
				}
			}
		})
	}
}
