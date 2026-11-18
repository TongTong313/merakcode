package feature_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// toolResultsOf returns the text of every tool result in a request, in order, with whether each failed.
func toolResultsOf(req model.Request) (texts []string, failed []bool) {
	for _, message := range req.Messages {
		for _, part := range message.Parts {
			if part.ToolResult == nil {
				continue
			}
			var text strings.Builder
			for _, inner := range part.ToolResult.Parts {
				text.WriteString(inner.Text)
			}
			texts, failed = append(texts, text.String()), append(failed, part.ToolResult.IsError)
		}
	}
	return texts, failed
}

func TestTheModelCreatesListsAndDeletesScheduledTasksWithTools(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var e *engine.Engine
	var step atomic.Int32
	var requests []model.Request
	provider := &enginetest.Chooser{T: t, Answer: func(req model.Request) []model.Chunk {
		requests = append(requests, req)
		switch step.Add(1) {
		case 1:
			return enginetest.Call("c1", "schedule_create", map[string]any{"cron": "0 9 * * *", "prompt": "Check the deployment"})
		case 2:
			return enginetest.Call("c2", "schedule_create", map[string]any{"cron": "every day", "prompt": "Never stored"})
		case 3:
			if listed, _ := e.ListSchedules(ctx); len(listed) != 1 || listed[0].Cron != "0 9 * * *" || listed[0].Prompt != "Check the deployment" || listed[0].Workdir == "" || listed[0].Next.IsZero() {
				t.Errorf("stored after the first call: %+v", listed)
			}
			return enginetest.Call("c3", "schedule_list", map[string]any{})
		case 4:
			listed, _ := e.ListSchedules(ctx)
			return enginetest.Call("c4", "schedule_delete", map[string]any{"id": string(listed[0].ID)})
		case 5:
			return enginetest.Call("c5", "schedule_delete", map[string]any{"id": "nothing"})
		}
		return enginetest.Text("Done.")
	}}
	var asked []string
	workdir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = workdir
	deps.Providers = map[string]model.Provider{"fake": provider}
	deps.Ask = func(_ context.Context, request permission.Request) (permission.Reply, error) {
		asked = append(asked, request.Spec.Name)
		return permission.Reply{Decision: permission.Allow}, nil
	}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if _, err := e.Chat(ctx, "fake", "Check the deployment every day at nine"); err != nil {
		t.Fatal(err)
	}
	last := requests[len(requests)-1]
	texts, failed := toolResultsOf(last)
	if len(texts) != 5 {
		t.Fatalf("tool results = %q", texts)
	}
	var created struct {
		ID   string `json:"id"`
		Cron string `json:"cron"`
		Next string `json:"next"`
	}
	if json.Unmarshal([]byte(texts[0]), &created) != nil || created.ID == "" || created.Cron != "0 9 * * *" || created.Next == "" || failed[0] {
		t.Fatalf("schedule_create answered %q (failed=%v)", texts[0], failed[0])
	}
	if !failed[1] || !strings.Contains(texts[1], "five fields") {
		t.Fatalf("an invalid expression was not refused with its reason: %q", texts[1])
	}
	if failed[2] || !strings.Contains(texts[2], created.ID) || !strings.Contains(texts[2], "Check the deployment") {
		t.Fatalf("schedule_list answered %q", texts[2])
	}
	if failed[3] || !failed[4] {
		t.Fatalf("delete results: %q %q (failed %v %v)", texts[3], texts[4], failed[3], failed[4])
	}
	if listed, _ := e.ListSchedules(ctx); len(listed) != 0 {
		t.Fatalf("schedules left: %+v", listed)
	}
	if fmt.Sprint(asked) != "[schedule_create schedule_create schedule_delete schedule_delete]" {
		t.Fatalf("permission asked for %v, want the writes only", asked)
	}
}

func TestADueScheduleStartsATitledConversationInItsFolderAndTellsTheInboxAndADeletedOneDoesNot(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	clock := &enginetest.ScheduleClock{}
	clock.Set("2026-11-12 08:00")
	provider := fake.New(t, fake.Reply{Text: "The deployment is healthy.", Expect: func(req model.Request) error {
		if len(req.Messages) == 0 || !strings.Contains(fmt.Sprint(req.Messages[len(req.Messages)-1].Parts), "Check the deployment") {
			return fmt.Errorf("the run did not send the prompt: %+v", req.Messages)
		}
		return nil
	}})
	folder := t.TempDir()
	deps2 := enginetest.Deps(t)
	deps2.Workdir = folder
	deps2.Now = clock.Now
	deps2.ScheduleInterval = time.Hour
	deps2.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	e.SetDefaultModel("fake", "scheduled", "")
	created, err := e.CreateSchedule(ctx, "0 9 * * *", "Check the deployment", "", folder)
	if err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 08:59")
	if err := e.CheckSchedules(ctx); err != nil || len(enginetest.InboxNotices(t, e)) != 0 {
		t.Fatalf("a run started early: %v", err)
	}
	clock.Set("2026-11-12 09:00")
	if err := e.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the notice of the run", func() bool { return len(enginetest.InboxNotices(t, e)) == 1 })
	notice := enginetest.InboxNotices(t, e)[0]
	if notice.Kind != "schedule" || notice.Text != "定时：Check the deployment" || len(notice.To) != 1 || notice.To[0] != "local-human" || notice.Session == "" { // i18n-allow
		t.Fatalf("notice = %+v", notice)
	}
	state, err := e.SessionSnapshot(ctx, notice.Session)
	if err != nil || state.Title != notice.Text || enginetest.CanonicalOf(state.Config.Workdir) != enginetest.CanonicalOf(folder) || state.Config.Model != "scheduled" {
		t.Fatalf("the conversation of the run: title=%q workdir=%q model=%q err=%v", state.Title, state.Config.Workdir, state.Config.Model, err)
	}
	if err := e.DeleteSchedule(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-13 09:00")
	if err := e.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // a second run would exhaust the script of the fake model and fail the test
	if len(enginetest.InboxNotices(t, e)) != 1 {
		t.Fatalf("a deleted schedule ran: %+v", enginetest.InboxNotices(t, e))
	}
}

func TestRunsMissedWhileTheEngineWasStoppedAreReportedOnceAtStartup(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	clock := &enginetest.ScheduleClock{}
	clock.Set("2026-11-12 09:00")
	shared, folder := storage.New(), t.TempDir()
	deps3 := enginetest.Deps(t)
	deps3.Store = shared
	deps3.Workdir = folder
	deps3.Now = clock.Now
	deps3.ScheduleInterval = time.Hour
	deps3.Providers = map[string]model.Provider{"fake": fake.New(t)}
	first, err := engine.New(deps3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.CreateSchedule(ctx, "*/30 * * * *", "Sweep the logs", "", folder); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 09:01")
	if err := first.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 10:01")
	deps4 := enginetest.Deps(t)
	deps4.Store = shared
	deps4.Workdir = folder
	deps4.Now = clock.Now
	deps4.ScheduleInterval = time.Hour
	deps4.Providers = map[string]model.Provider{"fake": fake.New(t)}
	second, err := engine.New(deps4)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	enginetest.WaitFor(t, ctx, "the notice of the missed runs", func() bool { return len(enginetest.InboxNotices(t, second)) == 1 })
	notice := enginetest.InboxNotices(t, second)[0]
	if notice.Kind != "schedule-missed" || notice.Count != 2 || notice.Text != "定时：Sweep the logs" { // i18n-allow
		t.Fatalf("notice = %+v", notice)
	}
	if listed, _ := second.ListSessions(ctx); len(listed) != 0 {
		t.Fatalf("missed runs were made up: %d conversations", len(listed))
	}
}
