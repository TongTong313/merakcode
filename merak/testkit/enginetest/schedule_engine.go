package enginetest

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

// ScheduleClock is a clock the test moves.
type ScheduleClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *ScheduleClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

func (c *ScheduleClock) Set(value string) {
	parsed, err := time.ParseInLocation("2006-01-02 15:04", value, time.Local)
	if err != nil {
		panic(err)
	}
	c.mu.Lock()
	c.now = parsed
	c.mu.Unlock()
}

// InboxNotices returns the notices in the personal inbox stream of the local person, oldest first.
func InboxNotices(t *testing.T, e *engine.Engine) []struct {
	group.Notice
	Session event.ID
} {
	t.Helper()
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{group.NoticeSent}})
	if err != nil {
		t.Fatal(err)
	}
	var notices []struct {
		group.Notice
		Session event.ID
	}
	for _, fact := range facts {
		if fact.Stream != "inbox:local-human" {
			continue
		}
		notice, err := event.Decode[group.Notice](fact)
		if err != nil {
			t.Fatal(err)
		}
		notices = append(notices, struct {
			group.Notice
			Session event.ID
		}{notice, fact.Scope.Session})
	}
	return notices
}

func CanonicalOf(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}
