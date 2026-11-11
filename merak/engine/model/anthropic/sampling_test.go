package anthropic_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
)

func TestSamplingParametersAreSentOnlyWhenTheyAreSetAndNotWhileThinking(t *testing.T) {
	temperature, topP, topK := 0.25, 0.9, 40
	for _, tc := range []struct {
		name     string
		thinking model.Thinking
		model    string
		set      bool
		want     bool
	}{
		{"set without thinking", model.ThinkingOff, "claude-3-5-sonnet-20241022", true, true},
		{"unset", model.ThinkingOff, "claude-3-5-sonnet-20241022", false, false},
		{"thinking on, where the API refuses them", model.ThinkingHigh, "claude-opus-4-7", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			}))
			defer host.Close()
			request := model.Request{Model: tc.model, Thinking: tc.thinking, MaxTokens: 20000, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}}
			if tc.set {
				request.Temperature, request.TopP, request.TopK = &temperature, &topP, &topK
			}
			stream, err := anthropic.New(anthropic.Options{BaseURL: host.URL}).Stream(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			collect(t, stream)
			body := <-requests
			_, hasTemperature := body["temperature"]
			_, hasTopP := body["top_p"]
			_, hasTopK := body["top_k"]
			if hasTemperature != tc.want || hasTopP != tc.want || hasTopK != tc.want {
				t.Fatalf("temperature=%v top_p=%v top_k=%v, want present=%v: %+v", body["temperature"], body["top_p"], body["top_k"], tc.want, body)
			}
			if tc.want && (body["temperature"] != 0.25 || body["top_p"] != 0.9 || body["top_k"] != float64(40)) {
				t.Fatalf("values: %+v", body)
			}
		})
	}
}
