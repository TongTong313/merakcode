package engine_test

import (
	"slices"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestChangingTheAutoArchiveDaysArchivesStaleTasksWithoutWaitingForTheHourlyPass(t *testing.T) {
	o := newOwnership(t)
	old := o.cancelled(o.loose("Finished two days ago"))
	live := o.loose("Still open")
	o.advance(2*24*time.Hour + time.Hour)
	archived := func() []event.ID {
		listed, err := o.e.ListTasks(o.ctx, task.Filter{Archived: true})
		if err != nil {
			t.Fatal(err)
		}
		return ids(listed)
	}
	o.e.ConfigureBoard(7)
	time.Sleep(200 * time.Millisecond)
	if got := archived(); len(got) != 0 {
		t.Fatalf("archived with 7 days: %v", got)
	}
	o.e.ConfigureBoard(1)
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Equal(archived(), []event.ID{old.ID}) {
		if time.Now().After(deadline) {
			t.Fatalf("archived with 1 day: %v, want only %s (the open task %s stays)", archived(), old.ID, live.ID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
