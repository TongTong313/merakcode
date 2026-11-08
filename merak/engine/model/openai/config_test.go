package openai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestBuiltinProvidersMapThinkingAndDecodeTheirStreams(t *testing.T) {
	for _, test := range []struct{ name, address, model string }{
		{"deepseek", "https://api.deepseek.com", "deepseek-reasoner"},
		{"moonshot", "https://api.moonshot.ai/v1", "kimi-k2.6"},
		{"zhipu", "https://open.bigmodel.cn/api/paas/v4", "glm-4.7"},
		{"dashscope", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.5-plus"},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, ok := openai.Builtin(test.name)
			if !ok || config.BaseURL != test.address {
				t.Fatalf("config=%+v found=%v", config, ok)
			}
			fixture, err := os.ReadFile("testdata/" + test.name + ".sse")
			if err != nil {
				t.Fatal(err)
			}
			requests := make(chan map[string]any, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write(fixture)
			}))
			defer server.Close()
			levels := []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax}
			for index, level := range levels {
				stream, err := openai.New(openai.Options{BaseURL: server.URL, Config: config}).Stream(context.Background(), model.Request{Model: test.model, Thinking: level, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Ready?"}}}}})
				if err != nil {
					t.Fatal(err)
				}
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
				stream.Close()
				message, usage, stop := collector.Message()
				if len(message.Parts) != 2 || message.Parts[0].Reasoning == nil || message.Parts[0].Reasoning.Provider != test.name || message.Parts[1].Text != "Ready." || usage.CacheRead != 6 || usage.Output != 8 || stop != model.EndTurn {
					t.Fatalf("message=%+v usage=%+v stop=%s", message, usage, stop)
				}
				body := <-requests
				enabled := level != model.ThinkingOff
				switch test.name {
				case "deepseek":
					want := "deepseek-chat"
					if enabled {
						want = "deepseek-reasoner"
					}
					if body["model"] != want {
						t.Fatalf("level=%s model=%v", level, body["model"])
					}
				case "moonshot", "zhipu":
					want := "disabled"
					if enabled {
						want = "enabled"
					}
					if body["thinking"].(map[string]any)["type"] != want {
						t.Fatalf("level=%s thinking=%v", level, body["thinking"])
					}
				case "dashscope":
					if body["enable_thinking"] != enabled {
						t.Fatalf("level=%s enabled=%v", level, body["enable_thinking"])
					}
					budgets := []float64{0, 1024, 4096, 8192, 16384, 32768}
					if enabled && body["thinking_budget"] != budgets[index] {
						t.Fatalf("level=%s budget=%v", level, body["thinking_budget"])
					}
				}
			}
		})
	}
}
