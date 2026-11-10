package leader

import (
	"slices"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// TurnLimiter shares a sliding minute across all threads of one group.
type TurnLimiter struct {
	mu      sync.Mutex
	now     func() time.Time
	changed func()
	group   []time.Time
	threads map[event.ID][]time.Time
	waiting []event.ID
}

func NewTurnLimiter(now func() time.Time, changed func()) *TurnLimiter {
	if now == nil {
		now = time.Now
	}
	return &TurnLimiter{now: now, changed: changed, threads: make(map[event.ID][]time.Time)}
}

// Take returns zero after reserving a slot, or the next deadline without consuming one.
func (l *TurnLimiter) Take(thread event.ID, threadMax, groupMax int) time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-time.Minute)
	trim := func(values []time.Time) []time.Time {
		index := 0
		for index < len(values) && !values[index].After(cutoff) {
			index++
		}
		return values[index:]
	}
	l.group = trim(l.group)
	for id, values := range l.threads {
		values = trim(values)
		if len(values) == 0 {
			delete(l.threads, id)
		} else {
			l.threads[id] = values
		}
	}
	if !slices.Contains(l.waiting, thread) {
		l.waiting = append(l.waiting, thread)
	}
	if len(l.group) < groupMax {
		for index, id := range l.waiting {
			if len(l.threads[id]) >= threadMax {
				continue
			}
			if id != thread {
				break
			}
			l.waiting = slices.Delete(l.waiting, index, index+1)
			l.group = append(l.group, now)
			l.threads[id] = append(l.threads[id], now)
			if l.changed != nil {
				l.changed()
			}
			return time.Time{}
		}
	}
	retry := now.Add(time.Minute)
	for _, values := range [][]time.Time{l.group, l.threads[thread]} {
		if len(values) > 0 {
			retry = minTime(retry, values[0].Add(time.Minute))
		}
	}
	return retry
}

func (l *TurnLimiter) Remove(thread event.ID) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if index := slices.Index(l.waiting, thread); index >= 0 {
		l.waiting = slices.Delete(l.waiting, index, index+1)
		if l.changed != nil {
			l.changed()
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
