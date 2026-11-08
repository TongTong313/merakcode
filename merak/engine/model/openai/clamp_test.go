package openai_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestClientsClampThinkingToCatalogLevels(t *testing.T) {
	for _, test := range []struct {
		provider, id string
		level        model.Thinking
		effort       string
		levels       []model.Thinking
	}{
		{"openai", "gpt-5", model.ThinkingMax, "high", nil},
		{"openai", "gpt-5", model.ThinkingOff, "low", nil},
		{"deepseek", "deepseek-flash", model.ThinkingMedium, "low", nil},
		{"moonshot", "kimi-k3", model.ThinkingOff, "low", nil},
		{"zhipu", "glm-5.3", model.ThinkingXHigh, "high", nil},
		{"openai", "gpt-5", model.ThinkingMax, "low", []model.Thinking{model.ThinkingLow}},
	} {
		t.Run(test.provider+"/"+string(test.level), func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				requests <- body
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer server.Close()
			config, _ := openai.Builtin(test.provider)
			catalogue := catalog.New()
			if test.levels != nil {
				catalogue = catalog.New(catalog.Options{Overrides: []catalog.Override{{Provider: test.provider, ID: test.id, Thinking: &test.levels}}})
			}
			stream, err := openai.New(openai.Options{BaseURL: server.URL, Config: config, Catalog: catalogue}).Stream(context.Background(), model.Request{Model: test.id, Thinking: test.level})
			if err != nil {
				t.Fatal(err)
			}
			stream.Close()
			body := <-requests
			if body["reasoning_effort"] != test.effort {
				t.Fatalf("body=%v want effort=%s", body, test.effort)
			}
		})
	}
}
