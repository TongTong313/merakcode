package openai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestGeminiAndOpenRouterUseCompatibleEndpointsAndProviderParameters(t *testing.T) {
	for _, test := range []struct {
		name, url, id string
		effort        model.Thinking
		want          string
	}{
		{"gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", model.ThinkingOff, "none"},
		{"gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.1-pro-preview", model.ThinkingOff, "low"},
		{"gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.1-pro-preview", model.ThinkingMax, "high"},
		{"openrouter", "https://openrouter.ai/api/v1", "anthropic/claude-opus-4-7", model.ThinkingXHigh, "xhigh"},
	} {
		t.Run(test.name+"/"+test.id+"/"+string(test.effort), func(t *testing.T) {
			config, ok := openai.Builtin(test.name)
			if !ok || config.BaseURL != test.url {
				t.Fatalf("config=%+v", config)
			}
			requests := make(chan map[string]any, 1)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				requests <- request
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, "data: [DONE]\n\n")
			}))
			defer host.Close()
			provider := openai.New(openai.Options{Config: config, BaseURL: host.URL, Parameters: map[string]json.RawMessage{"provider": json.RawMessage(`{"allow_fallbacks":false}`), "model": json.RawMessage(`"must-not-replace-model"`)}})
			stream, err := provider.Stream(context.Background(), model.Request{Model: test.id, Thinking: test.effort, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			request := <-requests
			if request["reasoning_effort"] != test.want || request["model"] != test.id || request["provider"].(map[string]any)["allow_fallbacks"] != false {
				t.Fatalf("request=%+v", request)
			}
		})
	}
}
