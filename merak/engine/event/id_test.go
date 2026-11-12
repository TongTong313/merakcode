package event_test

import (
	"sync"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func TestIdentifiersGrowStrictlyEvenWithinOneMillisecond(t *testing.T) {
	// 50000 calls take far less than 50000 milliseconds, so most of them share a clock tick.
	previous := event.NewID()
	for i := 0; i < 50000; i++ {
		next := event.NewID()
		if next <= previous {
			t.Fatalf("call %d: %s does not come after %s", i, next, previous)
		}
		previous = next
	}
}

func TestIdentifiersMadeByConcurrentCallersNeverRepeat(t *testing.T) {
	const workers, each = 8, 5000
	made := make([][]event.ID, workers)
	var wait sync.WaitGroup
	for w := range made {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for i := 0; i < each; i++ {
				made[w] = append(made[w], event.NewID())
			}
		}()
	}
	wait.Wait()
	seen := make(map[event.ID]bool, workers*each)
	for _, list := range made {
		for i, id := range list {
			if seen[id] {
				t.Fatalf("%s was made twice", id)
			}
			seen[id] = true
			if i > 0 && id <= list[i-1] {
				t.Fatalf("one caller got %s after %s", id, list[i-1])
			}
		}
	}
}
