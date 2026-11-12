package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

// usageTotals adds up the usage of finished turns. Costs are kept per currency because providers bill in different
// ones; a turn whose price is not known counts in UnpricedTurns and adds no cost.
type usageTotals struct {
	Turns         int                `json:"turns"`
	Input         int                `json:"input"`
	Output        int                `json:"output"`
	CacheRead     int                `json:"cacheRead"`
	CacheWrite    int                `json:"cacheWrite"`
	Cost          map[string]float64 `json:"cost,omitempty"`
	UnpricedTurns int                `json:"unpricedTurns,omitempty"`
}

func (t *usageTotals) add(usage model.Usage) {
	t.Turns++
	t.Input += usage.Input
	t.Output += usage.Output
	t.CacheRead += usage.CacheRead
	t.CacheWrite += usage.CacheWrite
	if usage.CostKnown {
		if t.Cost == nil {
			t.Cost = map[string]float64{}
		}
		t.Cost[usage.Currency] += usage.Cost
		return
	}
	if usage.Input+usage.Output > 0 {
		t.UnpricedTurns++
	}
}

type usageDay struct {
	Day string `json:"day"`
	usageTotals
}

type usageModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	usageTotals
}

type usageAgent struct {
	// Agent is the member that ran the turn; it is empty for a direct chat.
	Agent string `json:"agent"`
	usageTotals
}

type usageReport struct {
	Total  usageTotals  `json:"total"`
	Days   []usageDay   `json:"days"`
	Models []usageModel `json:"models"`
	Agents []usageAgent `json:"agents"`
}

// summarizeUsage groups the turn.finished events that happened at or after since by day (in zone), by the provider
// and model the turn ran on, and by the agent that ran it. A turn runs on the model its session was created with
// unless its turn.started event selected another one. A zero since keeps every turn.
func summarizeUsage(facts []event.Event, since time.Time, zone *time.Location) usageReport {
	type chosen struct{ provider, model string }
	sessions := map[event.ID]chosen{}
	selections := map[event.ID]chosen{}
	for _, fact := range facts {
		switch fact.Type {
		case "session.created":
			var created struct {
				Config struct {
					Provider string `json:"provider"`
					Model    string `json:"model"`
				} `json:"config"`
			}
			if json.Unmarshal(fact.Payload, &created) == nil {
				sessions[fact.Scope.Session] = chosen{created.Config.Provider, created.Config.Model}
			}
		case "turn.started":
			var started struct {
				Selection *struct {
					Provider string `json:"provider"`
					Model    string `json:"model"`
				} `json:"selection"`
			}
			if json.Unmarshal(fact.Payload, &started) == nil && started.Selection != nil {
				selections[fact.ID] = chosen{started.Selection.Provider, started.Selection.Model}
			}
		}
	}
	var report usageReport
	days := map[string]*usageDay{}
	models := map[chosen]*usageModel{}
	agents := map[string]*usageAgent{}
	for _, fact := range facts {
		if fact.Type != loop.TurnFinished || fact.Time.Before(since) {
			continue
		}
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil {
			continue
		}
		run, selected := selections[fact.Scope.Turn]
		if !selected {
			run = sessions[fact.Scope.Session]
		}
		day := fact.Time.In(zone).Format("2006-01-02")
		if days[day] == nil {
			days[day] = &usageDay{Day: day}
		}
		if models[run] == nil {
			models[run] = &usageModel{Provider: run.provider, Model: run.model}
		}
		agent := ""
		if fact.Actor.Kind == "agent" {
			agent = string(fact.Actor.ID)
		}
		if agents[agent] == nil {
			agents[agent] = &usageAgent{Agent: agent}
		}
		report.Total.add(outcome.Usage)
		days[day].add(outcome.Usage)
		models[run].add(outcome.Usage)
		agents[agent].add(outcome.Usage)
	}
	for _, row := range days {
		report.Days = append(report.Days, *row)
	}
	for _, row := range models {
		report.Models = append(report.Models, *row)
	}
	for _, row := range agents {
		report.Agents = append(report.Agents, *row)
	}
	sort.Slice(report.Days, func(i, j int) bool { return report.Days[i].Day < report.Days[j].Day })
	sort.Slice(report.Models, func(i, j int) bool {
		a, b := report.Models[i], report.Models[j]
		if a.Turns != b.Turns {
			return a.Turns > b.Turns
		}
		return a.Provider+"/"+a.Model < b.Provider+"/"+b.Model
	})
	sort.Slice(report.Agents, func(i, j int) bool {
		a, b := report.Agents[i], report.Agents[j]
		if a.Turns != b.Turns {
			return a.Turns > b.Turns
		}
		return a.Agent < b.Agent
	})
	return report
}

// statsCommand runs merak stats: token and cost totals from the finished turns of the engine, by day, model and agent.
func statsCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("stats", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	days := flags.Int("days", 30, "")
	machine := flags.Bool("json", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *days < 1 || *days > 3650 {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	defer client.Close()
	var facts []event.Event
	query := struct {
		Types []event.Type `json:"types"`
	}{[]event.Type{"session.created", "turn.started", loop.TurnFinished}}
	if err := client.Call(ctx, "events.find", query, &facts); err != nil {
		ui.failure(output, errorcode.StatsFailed)
		return 1
	}
	now := time.Now()
	zone := now.Location()
	year, month, day := now.Date()
	since := time.Date(year, month, day-(*days-1), 0, 0, 0, 0, zone)
	report := summarizeUsage(facts, since, zone)
	if *machine {
		if json.NewEncoder(output).Encode(report) != nil {
			return 1
		}
		return 0
	}
	if writeUsageReport(output, ui, report, *days) != nil {
		return 1
	}
	return 0
}

type usageRow struct {
	label  string
	totals usageTotals
}

type usageSection struct {
	heading string
	rows    []usageRow
}

func writeUsageReport(output io.Writer, ui *renderer, report usageReport, days int) error {
	if _, err := fmt.Fprintf(output, ui.text("statsTitle"), days); err != nil {
		return err
	}
	if report.Total.Turns == 0 {
		_, err := io.WriteString(output, ui.text("statsEmpty"))
		return err
	}
	var byDay, byModel, byAgent []usageRow
	for _, entry := range report.Days {
		byDay = append(byDay, usageRow{entry.Day, entry.usageTotals})
	}
	for _, entry := range report.Models {
		label := entry.Provider + "/" + entry.Model
		if entry.Provider == "" && entry.Model == "" {
			label = ui.text("statsUnknown")
		}
		byModel = append(byModel, usageRow{label, entry.usageTotals})
	}
	for _, entry := range report.Agents {
		label := entry.Agent
		if label == "" {
			label = ui.text("statsDirectChat")
		}
		byAgent = append(byAgent, usageRow{label, entry.usageTotals})
	}
	sections := []usageSection{
		{ui.text("statsTotal"), []usageRow{{"", report.Total}}},
		{ui.text("statsByDay"), byDay},
		{ui.text("statsByModel"), byModel},
		{ui.text("statsByAgent"), byAgent},
	}
	for _, section := range sections {
		if _, err := fmt.Fprintf(output, "\n%s\n", section.heading); err != nil {
			return err
		}
		table := tabwriter.NewWriter(output, 0, 0, 2, ' ', 0)
		fmt.Fprintf(table, "  \t%s\n", ui.text("statsHeader"))
		for _, entry := range section.rows {
			totals := entry.totals
			fmt.Fprintf(table, "  %s\t%d\t%d\t%d\t%d\t%d\t%s\n", entry.label, totals.Turns, totals.Input, totals.Output, totals.CacheRead, totals.CacheWrite, costCell(ui, totals))
		}
		if err := table.Flush(); err != nil {
			return err
		}
	}
	return nil
}

// costCell shows each currency's total and, when some turns have no price, how many.
func costCell(ui *renderer, totals usageTotals) string {
	currencies := make([]string, 0, len(totals.Cost))
	for currency := range totals.Cost {
		currencies = append(currencies, currency)
	}
	slices.Sort(currencies)
	var parts []string
	for _, currency := range currencies {
		parts = append(parts, strings.TrimSpace(fmt.Sprintf("%s %.4f", currency, totals.Cost[currency])))
	}
	if totals.UnpricedTurns > 0 {
		parts = append(parts, fmt.Sprintf(ui.text("statsUnpriced"), totals.UnpricedTurns))
	}
	if len(parts) == 0 {
		return ui.text("statsCostUnknown")
	}
	return strings.Join(parts, " + ")
}
