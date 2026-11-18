package feature_test

import (
	"slices"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestChangingTheAutoArchiveDaysArchivesStaleTasksWithoutWaitingForTheHourlyPass(t *testing.T) {
	o := enginetest.NewOwnership(t)
	old := o.Cancelled(o.Loose("Finished two days ago"))
	live := o.Loose("Still open")
	o.Advance(2*24*time.Hour + time.Hour)
	archived := func() []event.ID {
		listed, err := o.Engine.ListTasks(o.Context, task.Filter{Archived: true})
		if err != nil {
			t.Fatal(err)
		}
		return enginetest.IDs(listed)
	}
	o.Engine.ConfigureBoard(7)
	time.Sleep(200 * time.Millisecond)
	if got := archived(); len(got) != 0 {
		t.Fatalf("archived with 7 days: %v", got)
	}
	o.Engine.ConfigureBoard(1)
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Equal(archived(), []event.ID{old.ID}) {
		if time.Now().After(deadline) {
			t.Fatalf("archived with 1 day: %v, want only %s (the open task %s stays)", archived(), old.ID, live.ID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
