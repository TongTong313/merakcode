package schedule

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/store"
)

// lookback bounds how far back missed runs are counted, so a machine that was off for a year does not count minutes.
const lookback = 31 * 24 * time.Hour

// Runner starts the schedules that are due. Check is called about once a minute; Open once when the engine starts.
// A run that was due while the engine was not running is not made up for: Open reports how many there were.
type Runner struct {
	Schedules Schedules
	// Now is the clock; the engine passes its own so tests can move it.
	Now func() time.Time
	// Fire starts the run of a due schedule. It must not wait for the run to finish.
	Fire func(context.Context, Schedule)
	// Missed reports runs that were due and did not start, with how many.
	Missed func(context.Context, Schedule, int)

	mu   sync.Mutex
	last time.Time
}

// Open reads when the engine last checked and reports the runs that fell between then and now.
func (r *Runner) Open(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.Now()
	doc, err := r.Schedules.Docs.Fetch(ctx, clockKind, clockKey)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return r.advance(ctx, now)
	case err != nil:
		return err
	}
	if err := r.last.UnmarshalText(doc.Body); err != nil {
		return r.advance(ctx, now)
	}
	return r.sweep(ctx, now, func(s Schedule, count int) { r.Missed(ctx, s, count) })
}

// Check starts every schedule that became due since the last check. A schedule due more than once, because the
// machine slept, starts once and the rest are reported as missed.
func (r *Runner) Check(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sweep(ctx, r.Now(), func(s Schedule, count int) {
		r.Fire(ctx, s)
		if count > 1 {
			r.Missed(ctx, s, count-1)
		}
	})
}

func (r *Runner) sweep(ctx context.Context, now time.Time, due func(Schedule, int)) error {
	if r.last.IsZero() {
		return r.advance(ctx, now)
	}
	schedules, err := r.Schedules.List(ctx, now)
	if err != nil {
		return err
	}
	for _, s := range schedules {
		spec, err := Parse(s.Cron)
		if err != nil {
			continue
		}
		from := r.last
		if s.Created.After(from) {
			from = s.Created
		}
		if earliest := now.Add(-lookback); earliest.After(from) {
			from = earliest
		}
		if count := spec.CountBetween(from, now); count > 0 {
			due(s, count)
		}
	}
	return r.advance(ctx, now)
}

func (r *Runner) advance(ctx context.Context, now time.Time) error {
	if now.Before(r.last) {
		return nil
	}
	body, err := now.MarshalText()
	if err != nil {
		return err
	}
	var rev uint64
	if doc, err := r.Schedules.Docs.Fetch(ctx, clockKind, clockKey); err == nil {
		rev = doc.Rev
	}
	if err := r.Schedules.Docs.Put(ctx, store.Doc{Kind: clockKind, Key: clockKey, Rev: rev, Body: body}); err != nil {
		return err
	}
	r.last = now
	return nil
}
