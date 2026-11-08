package openai_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
)

func TestRequestsRespectTheReservedOutputLimit(t *testing.T) {
	for _, tc := range []struct{ provider, key string }{{"openai", "max_completion_tokens"}, {"deepseek", "max_tokens"}} {
		t.Run(tc.provider, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body[tc.key] != float64(256) {
					t.Errorf("output limit=%v", body[tc.key])
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer server.Close()
			config, _ := openai.Builtin(tc.provider)
			provider := openai.New(openai.Options{Config: config, BaseURL: server.URL, APIKey: "fixture"})
			stream, err := provider.Stream(context.Background(), model.Request{Model: "fixture", MaxTokens: 256, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}})
			if err != nil {
				t.Fatal(err)
			}
			stream.Close()
		})
	}
}
