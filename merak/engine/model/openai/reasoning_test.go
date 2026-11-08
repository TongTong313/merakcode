package openai_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestReasoningUsesTheConfiguredFieldAndReplayPolicy(t *testing.T) {
	for _, test := range []struct {
		name, field, owner string
		replay, want       bool
	}{
		{"replays local reasoning", "reasoning_content", "configured", true, true},
		{"drops foreign reasoning", "reasoning_content", "other", true, false},
		{"omits reasoning when disabled", "reasoning_content", "configured", false, false},
		{"uses a provider field", "reasoning", "configured", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{%q:\"New thought.\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", test.field)
			}))
			defer server.Close()
			provider := openai.New(openai.Options{BaseURL: server.URL, Config: openai.Config{Name: "configured", ReasoningField: test.field, SendReasoning: test.replay}})
			stream, err := provider.Stream(context.Background(), model.Request{Messages: []model.Message{{Role: model.Assistant, Parts: []model.Part{{Reasoning: &model.Reasoning{Text: "Previous thought.", Provider: test.owner}}, {Text: "Previous answer."}}}}})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			var collector model.Collector
			for {
				chunk, err := stream.Recv()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				collector.Add(chunk)
			}
			message, _, _ := collector.Message()
			if len(message.Parts) != 2 || message.Parts[0].Reasoning == nil || message.Parts[0].Reasoning.Text != "New thought." || message.Parts[0].Reasoning.Provider != "configured" {
				t.Fatalf("reasoning=%+v", message)
			}
			body := <-requests
			wire := body["messages"].([]any)[0].(map[string]any)
			value, present := wire[test.field]
			if present != test.want || test.want && value != "Previous thought." {
				t.Fatalf("replay=%v present=%v", value, present)
			}
		})
	}
}
