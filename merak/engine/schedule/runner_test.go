package schedule_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
	"github.com/TongTong313/merakcode/merak/engine/store"
	memory "github.com/TongTong313/merakcode/merak/engine/store/memory"
)

// rig is a runner on a store with a clock the test moves and a record of what the runner did.
type rig struct {
	t      *testing.T
	store  store.Store
	now    time.Time
	fired  []event.ID
	missed map[event.ID]int
	runner *schedule.Runner
}

func newRig(t *testing.T, shared store.Store, start string) *rig {
	t.Helper()
	if shared == nil {
		shared = memory.New()
	}
	r := &rig{t: t, store: shared, now: at(start), missed: map[event.ID]int{}}
	r.runner = &schedule.Runner{
		Schedules: schedule.Schedules{Docs: shared},
		Now:       func() time.Time { return r.now },
		Fire:      func(_ context.Context, s schedule.Schedule) { r.fired = append(r.fired, s.ID) },
		Missed:    func(_ context.Context, s schedule.Schedule, count int) { r.missed[s.ID] += count },
	}
	return r
}

func (r *rig) at(value string) *rig { r.now = at(value); return r }

func (r *rig) create(id, expression string) schedule.Schedule {
	r.t.Helper()
	created, err := r.runner.Schedules.Create(r.t.Context(), schedule.Schedule{ID: event.ID(id), Cron: expression, Prompt: "Check the deployment", Workdir: "/work", Owner: "me", Created: r.now})
	if err != nil {
		r.t.Fatal(err)
	}
	return created
}

func (r *rig) check() {
	r.t.Helper()
	if err := r.runner.Check(r.t.Context()); err != nil {
		r.t.Fatal(err)
	}
}

func TestADueScheduleFiresOnceAndADeletedOneNeverAgain(t *testing.T) {
	r := newRig(t, nil, "2026-11-12 08:00")
	r.create("deploy", "0 9 * * *")
	if err := r.runner.Open(t.Context()); err != nil {
		t.Fatal(err)
	}
	r.at("2026-11-12 08:59").check()
	if len(r.fired) != 0 {
		t.Fatalf("fired early: %v", r.fired)
	}
	r.at("2026-11-12 09:00").check()
	r.at("2026-11-12 09:00").check()
	r.now = r.now.Add(30 * time.Second)
	r.check()
	if !slices.Equal(r.fired, []event.ID{"deploy"}) {
		t.Fatalf("fired = %v, want once", r.fired)
	}
	r.at("2026-11-13 09:00").check()
	if len(r.fired) != 2 {
		t.Fatalf("fired = %v, want a second run the next day", r.fired)
	}
	if err := r.runner.Schedules.Delete(t.Context(), "deploy"); err != nil {
		t.Fatal(err)
	}
	r.at("2026-11-14 09:00").check()
	if len(r.fired) != 2 || len(r.missed) != 0 {
		t.Fatalf("a deleted schedule ran or was reported: fired=%v missed=%v", r.fired, r.missed)
	}
}

func TestRunsDueWhileTheEngineWasStoppedAreReportedAndNotMadeUp(t *testing.T) {
	shared := memory.New()
	before := newRig(t, shared, "2026-11-12 09:00")
	before.create("half-hourly", "*/30 * * * *")
	if err := before.runner.Open(t.Context()); err != nil {
		t.Fatal(err)
	}
	before.at("2026-11-12 09:01").check()

	after := newRig(t, shared, "2026-11-12 10:01")
	if _, err := after.runner.Schedules.Create(t.Context(), schedule.Schedule{ID: "newer", Cron: "* * * * *", Prompt: "Created while stopped", Workdir: "/work", Created: at("2026-11-12 10:00")}); err != nil {
		t.Fatal(err)
	}
	if err := after.runner.Open(t.Context()); err != nil {
		t.Fatal(err)
	}
	if after.missed["half-hourly"] != 2 || after.missed["newer"] != 1 || len(after.fired) != 0 {
		t.Fatalf("missed=%v fired=%v, want 2 half-hourly runs and 1 of the newer schedule reported and none started", after.missed, after.fired)
	}
	after.at("2026-11-12 10:02").check()
	if len(after.missed) != 2 || after.missed["half-hourly"] != 2 {
		t.Fatalf("the same runs were reported twice: %v", after.missed)
	}
}

func TestAFirstStartHasNothingToReportAndASleepingMachineStartsOnceAndReportsTheRest(t *testing.T) {
	first := newRig(t, nil, "2026-11-12 09:00")
	first.create("hourly", "0 * * * *")
	if err := first.runner.Open(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(first.missed) != 0 {
		t.Fatalf("a first start reported %v", first.missed)
	}
	first.at("2026-11-12 12:00").check()
	if !slices.Equal(first.fired, []event.ID{"hourly"}) || first.missed["hourly"] != 2 {
		t.Fatalf("fired=%v missed=%v, want one start and two reported", first.fired, first.missed)
	}
}

func TestDeletingAnUnknownScheduleFailsWithErrNotFound(t *testing.T) {
	r := newRig(t, nil, "2026-11-12 09:00")
	if err := r.runner.Schedules.Delete(t.Context(), "nothing"); err != schedule.ErrNotFound {
		t.Fatalf("error = %v", err)
	}
	if _, err := r.runner.Schedules.Create(t.Context(), schedule.Schedule{ID: "bad", Cron: "nope", Prompt: "x", Workdir: "/work"}); err == nil {
		t.Fatal("an invalid expression was stored")
	}
	r.create("one", "0 9 * * *")
	if _, err := r.runner.Schedules.Create(t.Context(), schedule.Schedule{ID: "one", Cron: "0 9 * * *", Prompt: "again", Workdir: "/work"}); err == nil {
		t.Fatal("a second schedule took the same id")
	}
	listed, err := r.runner.Schedules.List(t.Context(), r.now)
	if err != nil || len(listed) != 1 || !listed[0].Next.Equal(at("2026-11-13 09:00")) {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
}
