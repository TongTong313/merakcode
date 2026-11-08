package window_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

const structuredSummary = "# Summary of earlier work\n## Goal\nKeep the goal.\n## Constraints (verbatim)\nNo commits.\n## Decisions\nContinue.\n## Files touched\nfile.go\n## Current state\nTests pass.\n## Open questions\nNone.\n## References\nmrk://blob/saved\n## Earlier\nPrevious summary."

func TestModelSummarizerReusesTheFrozenPrefixInOneRequest(t *testing.T) {
	parent := model.Request{Model: "fixture", System: "Frozen rules", Tools: []model.ToolSpec{{Name: "read_file", Description: "Read a file"}}, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Earlier summary: preserve this"}}}, {Role: model.Assistant, Parts: []model.Part{{Text: "Original answer"}}}, {Role: model.User, Parts: []model.Part{{Text: "Keep this recent input"}}}}}
	provider := fake.New(t, fake.Reply{Text: structuredSummary, Expect: func(request model.Request) error {
		if request.System != parent.System || !reflect.DeepEqual(request.Tools, parent.Tools) || !reflect.DeepEqual(request.Messages[:2], parent.Messages[:2]) || len(request.Messages) != 3 || request.MaxTokens != 256 {
			return fmt.Errorf("summary request changed prefix: %+v", request)
		}
		instruction := request.Messages[2].Parts[0].Text
		for _, heading := range []string{"Constraints (verbatim)", "Files touched", "References", "Earlier"} {
			if !strings.Contains(instruction, heading) {
				return fmt.Errorf("missing heading %s", heading)
			}
		}
		return nil
	}})
	summarizer := window.ModelSummarizer{Provider: provider}
	got, err := summarizer.Summarize(context.Background(), window.SummaryRequest{Parent: parent, To: 2, MaxTokens: 256})
	if err != nil || got.Message.Role != model.User || len(got.Message.Parts) != 1 || got.Message.Parts[0].Text != structuredSummary {
		t.Fatalf("summary=%+v %v", got, err)
	}
}

func TestBrokenSummaryStreamKeepsReportedUsage(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":17,\"completion_tokens\":3}}\n\ndata: invalid\n\n")
	}))
	defer host.Close()
	summary, err := (window.ModelSummarizer{Provider: openai.New(openai.Options{BaseURL: host.URL})}).Summarize(context.Background(), window.SummaryRequest{Parent: model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Keep this"}}}}}, To: 1, MaxTokens: 256})
	if err == nil || summary.Usage.Input != 17 || summary.Usage.Output != 3 {
		t.Fatalf("summary=%+v error=%v", summary, err)
	}
}

func TestIncompleteSummaryIsRejectedWithoutLosingItsUsage(t *testing.T) {
	provider := fake.New(t, fake.Reply{Text: "Done", Usage: &model.Usage{Input: 10, Output: 1}})
	summary, err := (window.ModelSummarizer{Provider: provider}).Summarize(context.Background(), window.SummaryRequest{Parent: model.Request{Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Do not lose my constraints"}}}}}, To: 1, MaxTokens: 256})
	if err == nil || err.Error() != "MRK-4003" || summary.Usage.Input != 10 {
		t.Fatalf("summary=%+v error=%v", summary, err)
	}
}
