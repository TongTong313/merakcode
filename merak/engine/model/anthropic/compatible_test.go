package anthropic_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
)

func TestCompatibleMessagesEndpointsKeepProviderIdentity(t *testing.T) {
	fixture, err := os.ReadFile("testdata/thinking-tools.sse")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, url, id string }{
		{"deepseek", "https://api.deepseek.com/anthropic", "deepseek-flash"},
		{"moonshot", "https://api.moonshot.ai/anthropic", "kimi-k3"},
		{"zhipu", "https://open.bigmodel.cn/api/anthropic", "glm-5.3"},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, ok := anthropic.Builtin(test.name)
			if !ok || config.BaseURL != test.url {
				t.Fatalf("config=%+v", config)
			}
			requests := make(chan map[string]any, 1)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/compatible/v1/messages" || r.Header.Get("x-api-key") != "test-key" {
					t.Errorf("route=%s", r.URL.Path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write(fixture)
			}))
			defer host.Close()
			provider := anthropic.New(anthropic.Options{Config: config, BaseURL: host.URL + "/compatible", APIKey: "test-key"})
			stream, err := provider.Stream(context.Background(), model.Request{Model: test.id, Thinking: model.ThinkingHigh, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}})
			if err != nil {
				t.Fatal(err)
			}
			message, _, _ := collect(t, stream)
			if provider.Name() != test.name || message.Parts[0].Reasoning.Provider != test.name+"-anthropic" {
				t.Fatalf("provider=%s reasoning=%+v", provider.Name(), message.Parts[0].Reasoning)
			}
			body := <-requests
			if body["model"] != test.id || body["thinking"].(map[string]any)["type"] != "enabled" {
				t.Fatalf("request=%+v", body)
			}
			output, _ := body["output_config"].(map[string]any)
			if output["effort"] != "high" {
				t.Fatalf("compatible effort=%+v", output)
			}
		})
	}
}
