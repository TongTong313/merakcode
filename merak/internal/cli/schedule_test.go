package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
)

func TestScheduleCommandListsAndDeletesScheduledTasks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	project := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: project})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	created, err := e.CreateSchedule(t.Context(), "30 8 * * 1-5", "Check the deployment", "", project)
	if err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (int, string) {
		var out bytes.Buffer
		code := Run(args, strings.NewReader(""), &out)
		return code, out.String()
	}
	var listed []schedule.Schedule
	if code, out := run("schedule", "list"); code != 0 || json.Unmarshal([]byte(out), &listed) != nil || len(listed) != 1 || listed[0].ID != created.ID || listed[0].Cron != "30 8 * * 1-5" || listed[0].Next.IsZero() {
		t.Fatalf("schedule list = %d %s", code, out)
	}
	if code, _ := run("schedule", "delete"); code != 2 {
		t.Fatalf("delete without an id exited %d, want the usage code 2", code)
	}
	if code, _ := run("schedule", "delete", "nothing"); code == 0 {
		t.Fatal("deleting an unknown schedule succeeded")
	}
	if code, out := run("schedule", "delete", string(created.ID)); code != 0 {
		t.Fatalf("schedule delete = %d %s", code, out)
	}
	if code, out := run("schedule", "list"); code != 0 || strings.TrimSpace(out) != "[]" {
		t.Fatalf("schedule list after the delete = %d %q", code, out)
	}
}
