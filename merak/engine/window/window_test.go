package window_test

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

func TestBuildPreservesHistoryAndReportsBudgetOrRejectsOversizedInput(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		rejected    bool
	}{{"fits", "Hello", false}, {"oversized", strings.Repeat("large ", 1000), true}} {
		t.Run(tc.name, func(t *testing.T) {
			storage := memory.New()
			bus := event.NewBus(storage, time.Now, event.NewID)
			state := session.State{ID: "s", System: "Frozen rules", Config: session.Config{Provider: "fake", Model: "fixture"}, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: tc.input}}}}}
			before, _ := json.Marshal(state.Messages)
			builder := window.Builder{Budget: window.Budget{Window: 1000, Reserve: 100, Trigger: .9, Target: .6, KeepTurns: 1}, Counter: new(window.Counter), Bus: bus}
			request, err := builder.Build(context.Background(), &state)
			if tc.rejected {
				if err == nil || err.Error() != "MRK-4002" {
					t.Fatalf("oversized input error=%v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			after, _ := json.Marshal(state.Messages)
			if string(before) != string(after) || request.System != state.System || request.MaxTokens != 100 {
				t.Fatalf("request changed frozen inputs: %+v", request)
			}
			facts, err := storage.Read(context.Background(), "session:s", 1, 10)
			if err != nil || len(facts) != 1 || facts[0].Type != "session.budget" {
				t.Fatalf("budget facts=%+v %v", facts, err)
			}
			var budget window.Report
			if err := json.Unmarshal(facts[0].Payload, &budget); err != nil {
				t.Fatal(err)
			}
			if budget.Total != budget.System+budget.Tools+budget.Messages+budget.Reserve || budget.Total >= 1000 {
				t.Fatalf("budget=%+v", budget)
			}
		})
	}
}

func TestRebuildFailureKeepsHistoryAndReportsTheReason(t *testing.T) {
	for _, name := range []string{"unfinished tool round", "invalid summary"} {
		t.Run(name, func(t *testing.T) {
			storage := memory.New()
			state := session.State{ID: "s", Config: session.Config{Provider: "fake", Model: "fixture"}}
			for i := 0; i < 6; i++ {
				state.Messages = append(state.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: strings.Repeat("old ", 90)}}}, model.Message{Role: model.Assistant, Parts: []model.Part{{Text: strings.Repeat("reply ", 90)}}})
			}
			if name == "unfinished tool round" {
				state.Messages = append(state.Messages, model.Message{Role: model.Assistant, Parts: []model.Part{{ToolCall: &model.ToolCall{ID: "pending", Name: "read_file", Input: json.RawMessage(`{}`)}}}})
			}
			before, _ := json.Marshal(state.Messages)
			var summarizer window.Summarizer = window.FixedSummarizer{Text: structuredSummary}
			if name == "invalid summary" {
				summarizer = window.ModelSummarizer{Provider: fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "unexpected", Name: "read_file", Input: json.RawMessage(`{}`)}}, Usage: &model.Usage{Input: 17, Output: 3, CacheRead: 7}})}
			}
			builder := window.Builder{Budget: window.Budget{Window: 1800, Reserve: 40, Trigger: .9, Target: .6, KeepTurns: 1}, Counter: new(window.Counter), Bus: event.NewBus(storage, time.Now, event.NewID), Summarize: summarizer}
			_, err := builder.Build(context.Background(), &state)
			if err == nil || err.Error() != "MRK-4003" {
				t.Fatalf("error=%v", err)
			}
			after, _ := json.Marshal(state.Messages)
			if string(before) != string(after) {
				t.Fatal("failed rebuild changed history")
			}
			facts, err := storage.Read(context.Background(), "session:s", 1, 10)
			want := 1
			if name == "invalid summary" {
				want = 2
			}
			if err != nil || len(facts) != want || facts[len(facts)-1].Type != window.BudgetReported {
				t.Fatalf("failure facts=%+v %v", facts, err)
			}
			var report window.Report
			json.Unmarshal(facts[len(facts)-1].Payload, &report)
			if report.Code != "MRK-4003" {
				t.Fatalf("failure=%+v", report)
			}
			if name == "invalid summary" && (state.Usage.Input != 17 || state.Usage.Output != 3 || state.Usage.CacheRead != 7) {
				t.Fatalf("failed summary usage lost: %+v", state.Usage)
			}
		})
	}
}

func TestRebuildPreservesRecentTurnsStripsReasoningAndReplaysExactly(t *testing.T) {
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	state := session.State{ID: "s", System: "Frozen rules", Config: session.Config{Provider: "fake", Model: "fixture"}}
	for i := 0; i < 5; i++ {
		state.Messages = append(state.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: strings.Repeat("old ", 80)}}}, model.Message{Role: model.Assistant, Parts: []model.Part{{Reasoning: &model.Reasoning{Provider: "fake", Text: strings.Repeat("think ", 40)}}, {Text: strings.Repeat("reply ", 80)}}})
	}
	state.Messages = append(state.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: "Latest input must stay exact"}}})
	original, _ := json.Marshal(state)
	builder := window.Builder{Budget: window.Budget{Window: 1800, Reserve: 40, Trigger: .9, Target: .6, KeepTurns: 2}, Counter: new(window.Counter), Bus: bus, Summarize: window.FixedSummarizer{Text: "# Summary of earlier work\n## Goal\nPreserve the original goal.\n## Constraints (verbatim)\nNone.\n## Decisions\nContinue.\n## Files touched\nNone.\n## Current state\nIn progress.\n## Open questions\nNone.\n## References\nNone.\n## Earlier\nNone."}}
	request, err := builder.Build(context.Background(), &state)
	if err != nil {
		t.Fatal(err)
	}
	if builder.Counter.Estimate("fake", request).Total+40 > 1080 {
		t.Fatal("rebuilt request exceeds target")
	}
	if state.Messages[len(state.Messages)-1].Parts[0].Text != "Latest input must stay exact" || len(state.Messages) < 4 {
		t.Fatalf("recent turns lost: %+v", state.Messages)
	}
	for _, message := range state.Messages {
		for _, part := range message.Parts {
			if part.Reasoning != nil {
				t.Fatal("reasoning survived prefix replacement")
			}
		}
	}
	facts, err := storage.Read(context.Background(), "session:s", 1, 10)
	if err != nil || len(facts) != 3 || facts[0].Type != window.BudgetReported || facts[1].Type != session.Rebuilt || facts[2].Type != window.BudgetReported {
		t.Fatalf("facts=%+v %v", facts, err)
	}
	var replay session.State
	if err := json.Unmarshal(original, &replay); err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		if err := session.Fold(&replay, fact); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(replay.Messages, state.Messages) || replay.SummaryID == "" {
		t.Fatalf("replay=%+v actual=%+v", replay, state)
	}
	var prior session.State
	json.Unmarshal(original, &prior)
	if prior.Messages[1].Parts[0].Reasoning == nil {
		t.Fatal("original history was edited")
	}
}

func TestRebuildUsesTheEarliestWholeTurnThatCanFitTheSummary(t *testing.T) {
	storage := memory.New()
	state := session.State{ID: "s", Config: session.Config{Provider: "fake", Model: "fixture"}}
	for i := 0; i < 5; i++ {
		state.Messages = append(state.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: strings.Repeat("old ", 80)}}}, model.Message{Role: model.Assistant, Parts: []model.Part{{Text: strings.Repeat("reply ", 80)}}})
	}
	state.Messages = append(state.Messages, model.Message{Role: model.User, Parts: []model.Part{{Text: "Latest"}}})
	builder := window.Builder{Budget: window.Budget{Window: 1200, Reserve: 40, Trigger: .9, Target: .6, KeepTurns: 2}, Counter: new(window.Counter), Bus: event.NewBus(storage, time.Now, event.NewID), Summarize: window.FixedSummarizer{Text: structuredSummary}}
	if _, err := builder.Build(context.Background(), &state); err != nil {
		t.Fatal(err)
	}
	facts, err := storage.Read(context.Background(), "session:s", 2, 1)
	if err != nil || len(facts) != 1 {
		t.Fatalf("facts=%+v %v", facts, err)
	}
	rebuilt, err := event.Decode[session.Rebuild](facts[0])
	if err != nil || rebuilt.To != 6 {
		t.Fatalf("rebuild=%+v %v", rebuilt, err)
	}
}

func TestNextBudgetIncludesObservedCacheUsage(t *testing.T) {
	storage := memory.New()
	state := session.State{ID: "s", Config: session.Config{Provider: "fake", Model: "fixture"}, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}}
	builder := window.Builder{Budget: window.Budget{Window: 1000, Reserve: 100, Trigger: .9, Target: .6, KeepTurns: 1}, Counter: new(window.Counter), Bus: event.NewBus(storage, time.Now, event.NewID)}
	request, err := builder.Build(context.Background(), &state)
	if err != nil {
		t.Fatal(err)
	}
	builder.Observe("fake", request, model.Usage{Input: 16, CacheRead: 7, CacheWrite: 3})
	if _, err := builder.Build(context.Background(), &state); err != nil {
		t.Fatal(err)
	}
	facts, err := storage.Read(context.Background(), "session:s", 2, 1)
	if err != nil || len(facts) != 1 {
		t.Fatalf("budget count=%d %v", len(facts), err)
	}
	report, err := event.Decode[window.Report](facts[0])
	if err != nil || report.CacheRead != 7 || report.CacheWrite != 3 || report.Messages != 16 {
		t.Fatalf("report=%+v %v", report, err)
	}
}
