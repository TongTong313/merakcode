package leader_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestEnvironmentChangesRouteToActiveTaskScopesAndTheirRoot(t *testing.T) {
	cards := []task.Card{
		{ID: "goal", Status: task.Running, Phase: task.PhaseDoing},
		{ID: "docs", Parent: "goal", Status: task.Running, Areas: []string{"docs"}, Claims: []task.Claim{{ID: "docs-claim", Member: "writer", Status: task.ClaimActive}}},
		{ID: "examples", Parent: "goal", Status: task.Running, Areas: []string{"examples/**/*.ts"}},
		{ID: "other", Status: task.Running, Areas: []string{"src"}, Claims: []task.Claim{{ID: "code-claim", Status: task.ClaimActive, Scope: []string{"src/api"}}}},
		{ID: "finished", Status: task.Done, Areas: []string{"docs"}},
	}
	for _, test := range []struct {
		name, payload string
		want          []event.ID
	}{
		{"directory scope", `{"paths":["docs/guide.md"]}`, []event.ID{"goal"}},
		{"glob scope", `{"paths":["examples/guide.ts"]}`, []event.ID{"goal"}},
		{"roots are unique", `{"paths":["docs/guide.md","examples/guide.ts"]}`, []event.ID{"goal"}},
		{"active claim scope", `{"paths":["src/api/client.go"]}`, []event.ID{"other"}},
		{"outside active claim", `{"paths":["src/ui/page.ts"]}`, nil},
		{"outside tasks", `{"paths":["README.md"]}`, nil},
		{"commit paths", `{"commits":[{"id":"head","paths":["docs/guide.md"]}]}`, []event.ID{"goal"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := leader.EnvironmentTargets(event.Event{Type: "file.changed", Payload: json.RawMessage(test.payload)}, cards)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("targets=%v want=%v", got, test.want)
			}
		})
	}
}

func TestOwnedChangesInformOtherTasksButDoNotWakeTheirOwnTaskAgain(t *testing.T) {
	cards := []task.Card{
		{ID: "first", Status: task.Running, Areas: []string{"docs"}, Claims: []task.Claim{{ID: "own", Status: task.ClaimActive}}},
		{ID: "second", Status: task.Running, Areas: []string{"docs"}},
	}
	for _, test := range []struct {
		name, payload string
		targets       []event.ID
		external      bool
	}{
		{"own file", `{"paths":["docs/guide.md"],"claims":{"docs/guide.md":"own"}}`, []event.ID{"second"}, false},
		{"own empty commit", `{"commits":[{"id":"head","paths":[]}],"claims":{"head":"own"}}`, nil, false},
		{"external empty commit", `{"commits":[{"id":"head","paths":[]}]}`, nil, true},
		{"own commit", `{"commits":[{"id":"head","paths":["docs/guide.md"]}],"claims":{"head":"own"}}`, []event.ID{"second"}, false},
		{"mixed commits", `{"commits":[{"id":"head","paths":["docs/guide.md"]},{"id":"external","paths":["docs/other.md"]}],"claims":{"head":"own"}}`, []event.ID{"first", "second"}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			fact := event.Event{Type: "repo.changed", Payload: json.RawMessage(test.payload)}
			if got := leader.EnvironmentTargets(fact, cards); !reflect.DeepEqual(got, test.targets) {
				t.Fatalf("targets=%v want=%v", got, test.targets)
			}
			if got := leader.EnvironmentHasExternal(fact); got != test.external {
				t.Fatalf("external=%v", got)
			}
		})
	}
}
