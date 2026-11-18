package feature_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	storage "github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

// scheduledAgentEngine waits for a missed-run notice before advancing the clock of the engine under test.
func scheduledAgentEngine(t *testing.T, ctx context.Context, clock *enginetest.ScheduleClock, folder string, provider model.Provider) *engine.Engine {
	t.Helper()
	shared := storage.New()
	clock.Set("2026-11-12 07:00")
	deps := enginetest.Deps(t)
	deps.Store = shared
	deps.Workdir = folder
	deps.Now = clock.Now
	deps.ScheduleInterval = time.Hour
	seed, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = seed.Close() })
	ready, err := seed.CreateSchedule(ctx, "30 7 * * *", "Confirm scheduler startup", "", folder)
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 08:00")
	deps2 := enginetest.Deps(t)
	deps2.Store = shared
	deps2.Workdir = folder
	deps2.Now = clock.Now
	deps2.ScheduleInterval = time.Hour
	deps2.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	enginetest.WaitFor(t, ctx, "the scheduler startup notice", func() bool { return len(enginetest.InboxNotices(t, e)) == 1 })
	if notice := enginetest.InboxNotices(t, e)[0]; notice.Kind != "schedule-missed" || notice.Count != 1 || notice.Session != "" {
		t.Fatalf("scheduler startup notice: %+v", notice)
	}
	// Open publishes the notice while holding the runner lock; Check waits for Open to release that lock.
	if err := e.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteSchedule(ctx, ready.ID); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestScheduledTasksRunTheSelectedLibraryOrConfiguredAgent(t *testing.T) {
	for _, tc := range []struct {
		name       string
		configured bool
		byID       bool
	}{
		{name: "library name"},
		{name: "library id", byID: true},
		{name: "configuration name", configured: true},
		{name: "configuration id", configured: true, byID: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			clock := &enginetest.ScheduleClock{}
			const prompt = "Inspect the scheduled deployment"
			const system = "You are the selected deployment inspector."
			provider := fake.New(t, fake.Reply{Text: "Inspection complete.", Expect: func(req model.Request) error {
				if req.Model != "selected" || !strings.Contains(req.System, system) {
					return fmt.Errorf("selected agent was not applied: model=%q system=%q", req.Model, req.System)
				}
				if len(req.Messages) == 0 || !strings.Contains(fmt.Sprint(req.Messages[len(req.Messages)-1].Parts), prompt) {
					return fmt.Errorf("scheduled prompt is missing: %+v", req.Messages)
				}
				return nil
			}})
			folder := t.TempDir()
			e := scheduledAgentEngine(t, ctx, clock, folder, provider)
			e.SetDefaultModel("fake", "fallback", "")
			selected := "inspector"
			if tc.configured {
				e.ConfigureAgents(registry.AgentSettings{Agents: map[string]config.Agent{"inspector": {Model: "fake/selected", Prompt: system}}})
				if tc.byID {
					selected = "config:inspector"
				}
			} else {
				agent, err := e.SaveAgent(ctx, "local-human", definition.Agent{Name: "inspector", Model: definition.ModelRef{Provider: "fake", Model: "selected"}, System: system})
				if err != nil {
					t.Fatal(err)
				}
				if tc.byID {
					selected = string(agent.ID)
				}
			}
			created, err := e.CreateSchedule(ctx, "0 9 * * *", prompt, selected, folder)
			if err != nil || created.Agent != selected {
				t.Fatalf("create selected-agent schedule: agent=%q err=%v", created.Agent, err)
			}
			clock.Set("2026-11-12 08:59")
			if err := e.CheckSchedules(ctx); err != nil {
				t.Fatal(err)
			}
			clock.Set("2026-11-12 09:00")
			if err := e.CheckSchedules(ctx); err != nil {
				t.Fatal(err)
			}
			enginetest.WaitFor(t, ctx, "the selected agent's scheduled result", func() bool { return len(enginetest.InboxNotices(t, e)) == 2 })
			notice := enginetest.InboxNotices(t, e)[1]
			if notice.Kind != "schedule" || notice.Session == "" || len(notice.To) != 1 || notice.To[0] != "local-human" {
				t.Fatalf("selected agent result: %+v", notice)
			}
			state, err := e.SessionSnapshot(ctx, notice.Session)
			if err != nil || state.Config.Model != "selected" || enginetest.CanonicalOf(state.Config.Workdir) != enginetest.CanonicalOf(folder) {
				t.Fatalf("scheduled session: model=%q folder=%q err=%v", state.Config.Model, state.Config.Workdir, err)
			}
		})
	}
}

func TestScheduledTasksRejectMissingAgentsAndReportAnAgentDeletedBeforeTheRun(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	clock := &enginetest.ScheduleClock{}
	folder := t.TempDir()
	e := scheduledAgentEngine(t, ctx, clock, folder, fake.New(t))
	_, err := e.CreateSchedule(ctx, "0 9 * * *", "Inspect deployment", "missing-agent", folder)
	var coded *errorcode.Error
	if !errors.As(err, &coded) || coded.Code != errorcode.ScheduleInvalid {
		t.Fatalf("missing agent error = %v", err)
	}
	if listed, err := e.ListSchedules(ctx); err != nil || len(listed) != 0 {
		t.Fatalf("missing-agent schedule was stored: %+v, %v", listed, err)
	}
	agent, err := e.SaveAgent(ctx, "local-human", definition.Agent{Name: "temporary inspector", Model: definition.ModelRef{Provider: "fake", Model: "selected"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.CreateSchedule(ctx, "0 9 * * *", "Inspect deployment", agent.Name, folder); err != nil {
		t.Fatal(err)
	}
	if err := e.DeleteAgent(ctx, "local-human", agent.ID); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 08:59")
	if err := e.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	clock.Set("2026-11-12 09:00")
	if err := e.CheckSchedules(ctx); err != nil {
		t.Fatal(err)
	}
	enginetest.WaitFor(t, ctx, "the missing scheduled agent notice", func() bool { return len(enginetest.InboxNotices(t, e)) == 2 })
	notice := enginetest.InboxNotices(t, e)[1]
	if notice.Kind != "blocked" || notice.Text != errorcode.ScheduleRunFailed || notice.Session != "" || len(notice.To) != 1 || notice.To[0] != "local-human" {
		t.Fatalf("missing scheduled agent notice: %+v", notice)
	}
	if sessions, err := e.ListSessions(ctx); err != nil || len(sessions) != 0 {
		t.Fatalf("a deleted agent started a session: %+v, %v", sessions, err)
	}
}
