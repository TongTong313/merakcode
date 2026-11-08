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
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

func TestRequestPreservesPrefixAndMapsThinkingWithoutChangingOutputLimit(t *testing.T) {
	for _, test := range []struct {
		name         string
		thinking     model.Thinking
		mode, effort string
		budget       int
	}{
		{"claude-opus-4-7", model.ThinkingOff, "disabled", "", 0},
		{"claude-opus-4-7", model.ThinkingLow, "adaptive", "low", 0},
		{"claude-opus-4-7", model.ThinkingMedium, "adaptive", "medium", 0},
		{"claude-opus-4-7", model.ThinkingHigh, "adaptive", "high", 0},
		{"claude-opus-4-7", model.ThinkingXHigh, "adaptive", "xhigh", 0},
		{"claude-opus-4-7", model.ThinkingMax, "adaptive", "max", 0},
		{"claude-sonnet-4-6", model.ThinkingXHigh, "adaptive", "high", 0},
		{"claude-opus-5", model.ThinkingOff, "adaptive", "low", 0},
		{"claude-3-7-sonnet-20250219", model.ThinkingMedium, "enabled", "", 4096},
	} {
		t.Run(test.name+"/"+string(test.thinking), func(t *testing.T) {
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
			stream, err := anthropic.New(anthropic.Options{BaseURL: host.URL}).Stream(context.Background(), model.Request{Model: test.name, Thinking: test.thinking, MaxTokens: 20000, System: "Frozen rules", Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}, Tools: []model.ToolSpec{{Name: "read_file", Description: "Read a file", Input: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}`)}}})
			if err != nil {
				t.Fatal(err)
			}
			collect(t, stream)
			body := <-requests
			if body["max_tokens"] != float64(20000) || body["system"] == nil || body["tools"] == nil || body["thinking"] == nil {
				t.Fatalf("request=%+v", body)
			}
			system := body["system"].([]any)[0].(map[string]any)
			if system["text"] != "Frozen rules" || system["cache_control"].(map[string]any)["type"] != "ephemeral" || body["cache_control"].(map[string]any)["type"] != "ephemeral" {
				t.Fatalf("prefix=%+v", body)
			}
			tool := body["tools"].([]any)[0].(map[string]any)
			if tool["name"] != "read_file" || tool["input_schema"].(map[string]any)["additionalProperties"] != false {
				t.Fatalf("tool=%+v", tool)
			}
			thinking := body["thinking"].(map[string]any)
			if thinking["type"] != test.mode {
				t.Fatalf("thinking=%+v", thinking)
			}
			if test.effort != "" && body["output_config"].(map[string]any)["effort"] != test.effort {
				t.Fatalf("effort=%v", body["output_config"])
			}
			if test.budget > 0 && thinking["budget_tokens"] != float64(test.budget) {
				t.Fatalf("budget=%v", thinking)
			}
		})
	}
}

func TestCatalogOverrideClampsAnthropicEffort(t *testing.T) {
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
	levels := []model.Thinking{model.ThinkingLow}
	c := catalog.New(catalog.Options{Overrides: []catalog.Override{{Provider: "anthropic", ID: "claude-opus-4-7", Thinking: &levels}}})
	stream, err := anthropic.New(anthropic.Options{BaseURL: host.URL, Catalog: c}).Stream(context.Background(), model.Request{Model: "claude-opus-4-7", Thinking: model.ThinkingMax, System: "Rules", Cache: model.CacheHint{TTL: "1h"}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	body := <-requests
	if body["output_config"].(map[string]any)["effort"] != "low" {
		t.Fatalf("request=%+v", body)
	}
	if body["cache_control"].(map[string]any)["ttl"] != "1h" || body["system"].([]any)[0].(map[string]any)["cache_control"].(map[string]any)["ttl"] != "1h" {
		t.Fatalf("cache hint ignored: %+v", body)
	}
}
