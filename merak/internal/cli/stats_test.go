package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func TestStatsTotalsMatchTheUsageInTheTurnFinishedEvents(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	priced := func(input, output int, cost float64) *model.Usage {
		return &model.Usage{Input: input, Output: output, CacheRead: 7, Cost: cost, CostKnown: true, Currency: "USD"}
	}
	provider := fake.New(t,
		fake.Reply{Text: "one", Usage: priced(100, 20, 0.5)},
		fake.Reply{Text: "two", Usage: priced(300, 40, 0.25)},
	)
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	for _, prompt := range []string{"first", "second"} {
		var out bytes.Buffer
		if code := Run([]string{"run", "--provider", "fake", "--model", "fixture", prompt}, strings.NewReader(""), &out); code != 0 {
			t.Fatalf("run=%d %s", code, out.String())
		}
	}
	ctx := context.Background()
	client, err := connectEngine(ctx, home+"/data")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var finished []event.Event
	if err := client.Call(ctx, "events.find", store.Query{Types: []event.Type{loop.TurnFinished}}, &finished); err != nil || len(finished) != 2 {
		t.Fatalf("events=%d err=%v", len(finished), err)
	}
	var want model.Usage
	for _, fact := range finished {
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil {
			t.Fatal(err)
		}
		want.Input += outcome.Usage.Input
		want.Output += outcome.Usage.Output
		want.CacheRead += outcome.Usage.CacheRead
		want.Cost += outcome.Usage.Cost
	}
	if want.Input != 400 || want.Output != 60 {
		t.Fatalf("the fixture usage did not reach the events: %+v", want)
	}

	var out bytes.Buffer
	if code := Run([]string{"stats", "--json"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("stats=%d %s", code, out.String())
	}
	var report usageReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("stats --json is not JSON: %v\n%s", err, out.String())
	}
	total := report.Total
	if total.Turns != 2 || total.Input != want.Input || total.Output != want.Output || total.CacheRead != want.CacheRead || math.Abs(total.Cost["USD"]-want.Cost) > 1e-9 {
		t.Errorf("total=%+v want=%+v", total, want)
	}
	if len(report.Days) != 1 || report.Days[0].Turns != 2 || report.Days[0].Input != want.Input {
		t.Errorf("days=%+v", report.Days)
	}
	if len(report.Models) != 1 || report.Models[0].Provider != "fake" || report.Models[0].Model != "fixture" || report.Models[0].Output != want.Output {
		t.Errorf("models=%+v", report.Models)
	}
	if len(report.Agents) != 1 || report.Agents[0].Turns != 2 {
		t.Errorf("agents=%+v", report.Agents)
	}

	for language, want := range map[string]string{"en": "By model", "zh": "按模型"} {
		out.Reset()
		if code := Run([]string{"--lang", language, "stats"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), want) || !strings.Contains(out.String(), "fixture") {
			t.Errorf("%s stats=%d\n%s", language, code, out.String())
		}
	}
}

func TestStatsRejectsAnInvalidNumberOfDays(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for _, args := range [][]string{{"stats", "--days", "0"}, {"stats", "--days", "-3"}, {"stats", "extra"}} {
		var out bytes.Buffer
		if code := Run(args, strings.NewReader(""), &out); code != 2 {
			t.Errorf("%v: code=%d", args, code)
		}
	}
}

func TestSummarizeUsageGroupsTurnsByDayModelAndAgent(t *testing.T) {
	zone := time.UTC
	at := func(day, clock string) time.Time {
		parsed, err := time.ParseInLocation("2006-01-02 15:04", day+" "+clock, zone)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}
	created := func(id, provider, name string, member event.ID) event.Event {
		body, _ := json.Marshal(map[string]any{"config": map[string]any{"provider": provider, "model": name, "member": member}})
		return event.Event{ID: event.ID("created-" + id), Type: "session.created", Time: at("2026-11-01", "08:00"), Scope: event.Scope{Session: event.ID(id)}, Payload: body}
	}
	started := func(id, turn string, selection *session.Selection) event.Event {
		body, _ := json.Marshal(map[string]any{"selection": selection})
		return event.Event{ID: event.ID(turn), Type: "turn.started", Time: at("2026-11-01", "08:01"), Scope: event.Scope{Session: event.ID(id)}, Payload: body}
	}
	finished := func(id, turn string, when time.Time, actor event.Actor, usage model.Usage) event.Event {
		body, _ := json.Marshal(loop.Outcome{Stop: loop.Answered, Usage: usage})
		return event.Event{ID: event.ID("done-" + turn), Type: loop.TurnFinished, Time: when, Scope: event.Scope{Session: event.ID(id), Turn: event.ID(turn)}, Actor: actor, Payload: body}
	}
	usd := func(input, output int, cost float64) model.Usage {
		return model.Usage{Input: input, Output: output, Cost: cost, CostKnown: true, Currency: "USD"}
	}
	facts := []event.Event{
		created("s1", "openai", "gpt", ""),
		created("s2", "anthropic", "sonnet", "member-1"),
		started("s1", "t1", nil),
		started("s1", "t2", &session.Selection{Provider: "deepseek", Model: "chat"}),
		started("s2", "t3", nil),
		started("s2", "t4", nil),
		finished("s1", "t1", at("2026-11-01", "09:00"), event.Actor{Kind: event.ActorAgent}, usd(10, 1, 0.5)),
		finished("s1", "t2", at("2026-11-02", "23:59"), event.Actor{Kind: event.ActorAgent}, model.Usage{Input: 20, Output: 2, CostKnown: false}),
		finished("s2", "t3", at("2026-11-02", "00:00"), event.Actor{Kind: event.ActorAgent, ID: "member-1"}, model.Usage{Input: 5, Output: 5, Cost: 3, CostKnown: true, Currency: "CNY"}),
		finished("s2", "t4", at("2026-10-01", "00:00"), event.Actor{Kind: event.ActorAgent, ID: "member-1"}, usd(1000, 1000, 9)),
		finished("missing", "t5", at("2026-11-02", "10:00"), event.Actor{}, usd(1, 1, 0.01)),
	}
	report := summarizeUsage(facts, at("2026-10-15", "00:00"), zone)

	if report.Total.Turns != 4 || report.Total.Input != 36 || report.Total.Output != 9 {
		t.Errorf("total=%+v (a turn before the window must not count)", report.Total)
	}
	if math.Abs(report.Total.Cost["USD"]-0.51) > 1e-9 || report.Total.Cost["CNY"] != 3 || report.Total.UnpricedTurns != 1 {
		t.Errorf("total cost=%v unpriced=%d", report.Total.Cost, report.Total.UnpricedTurns)
	}
	days := map[string]int{}
	for _, day := range report.Days {
		days[day.Day] = day.Turns
	}
	if len(days) != 2 || days["2026-11-01"] != 1 || days["2026-11-02"] != 3 {
		t.Errorf("days=%v", days)
	}
	if len(report.Days) == 2 && report.Days[0].Day > report.Days[1].Day {
		t.Errorf("days are not in order: %+v", report.Days)
	}
	models := map[string]int{}
	for _, row := range report.Models {
		models[row.Provider+"/"+row.Model] = row.Turns
	}
	want := map[string]int{"openai/gpt": 1, "deepseek/chat": 1, "anthropic/sonnet": 1, "/": 1}
	if len(models) != len(want) {
		t.Fatalf("models=%v", models)
	}
	for key, turns := range want {
		if models[key] != turns {
			t.Errorf("models=%v", models)
		}
	}
	agents := map[string]int{}
	for _, row := range report.Agents {
		agents[row.Agent] = row.Turns
	}
	if len(agents) != 2 || agents["member-1"] != 1 || agents[""] != 3 {
		t.Errorf("agents=%v", agents)
	}
}
