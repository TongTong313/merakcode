package task

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

// DefaultAutoArchiveDays is how long a finished task stays on the board before it is archived.
const DefaultAutoArchiveDays = 3

// tidyEvery is how often the board looks for finished tasks to archive.
const tidyEvery = time.Hour

// Board is the global view of the tasks of one client: every group's tasks and the ones no group has taken. It
// archives finished tasks after the number of days the settings give.
type Board struct {
	pool   *Pool
	groups *group.Manager
	now    func() time.Time
	days   atomic.Int64
}

// NewBoard builds the board over a pool; now is the clock of the engine.
func NewBoard(pool *Pool, groups *group.Manager, now func() time.Time) *Board {
	b := &Board{pool: pool, groups: groups, now: now}
	b.days.Store(DefaultAutoArchiveDays)
	return b
}

// Configure sets how many days a finished task stays on the board before it is archived; 0 keeps them all.
func (b *Board) Configure(autoArchiveDays int) { b.days.Store(int64(autoArchiveDays)) }

// Groups gives the local groups of a human with the ids of the tasks each owns.
func (b *Board) Groups(ctx context.Context, human event.ID) ([]group.Listing, error) {
	groups, err := b.groups.List(ctx, human)
	if err != nil {
		return nil, err
	}
	listed := make([]group.Listing, 0, len(groups))
	for _, g := range groups {
		cards, err := b.pool.List(ctx, g.ID)
		if err != nil {
			return nil, err
		}
		tasks := make([]event.ID, 0, len(cards))
		for _, card := range cards {
			tasks = append(tasks, card.ID)
		}
		listed = append(listed, group.Listing{Group: g, Tasks: tasks})
	}
	return listed, nil
}

// ArchiveStale archives the tasks that finished more days ago than the board keeps them.
func (b *Board) ArchiveStale(ctx context.Context) error {
	days := b.days.Load()
	if days <= 0 {
		return nil
	}
	ids, err := b.pool.FinishedBefore(ctx, b.now().Add(-time.Duration(days)*24*time.Hour))
	if err != nil || len(ids) == 0 {
		return err
	}
	_, err = b.pool.Archive(ctx, ids, true, event.Actor{Kind: event.ActorSystem, ID: "system"})
	return err
}

// Run archives stale tasks once an hour until the context ends.
func (b *Board) Run(ctx context.Context, logger *slog.Logger) {
	ticker := time.NewTicker(tidyEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := b.ArchiveStale(ctx); err != nil && logger != nil {
				logger.Warn("finished tasks could not be archived")
			}
		}
	}
}
