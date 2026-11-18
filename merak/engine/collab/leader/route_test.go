package leader_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// A group has one Leader thread: facts about any of its tasks are routed to it.
func TestEveryFactOfAGroupIsRoutedToItsOneLeaderThread(t *testing.T) {
	g := group.Group{ID: "g", Leader: "lead"}
	next := 0
	threads := leader.NewThreads(g, &leader.State{}, func() event.ID { next++; return event.ID(string(rune('a' + next))) })
	about := func(task event.ID) event.Event {
		return event.Event{Scope: event.Scope{Group: "g", Task: task}}
	}
	first := threads.Route(about(""))
	for _, task := range []event.ID{"x", "y", "z"} {
		if got := threads.Route(about(task)); got != first {
			t.Fatalf("a fact of task %q has its own thread", task)
		}
	}
	if first.Key != "g" || first.Leader != "lead" || first.Session.Scope.Task != "" {
		t.Fatalf("thread = %+v", first)
	}
	if len(threads.List()) != 1 {
		t.Fatalf("threads = %d, want one", len(threads.List()))
	}
	if threads.Route(event.Event{Scope: event.Scope{Group: "other"}}) != nil {
		t.Fatal("a fact of another group was routed")
	}
}
