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

func TestSamplingParametersAreSentOnlyWhenTheyAreSet(t *testing.T) {
	temperature, topP := 0.25, 0.9
	for _, tc := range []struct {
		name    string
		request model.Request
		want    map[string]any
	}{
		{"set", model.Request{Temperature: &temperature, TopP: &topP}, map[string]any{"temperature": 0.25, "top_p": 0.9}},
		{"unset", model.Request{}, map[string]any{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				for _, key := range []string{"temperature", "top_p"} {
					if body[key] != tc.want[key] {
						t.Errorf("%s = %v, want %v", key, body[key], tc.want[key])
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer server.Close()
			config, _ := openai.Builtin("deepseek")
			provider := openai.New(openai.Options{Config: config, BaseURL: server.URL, APIKey: "fixture"})
			tc.request.Model = "fixture"
			tc.request.Messages = []model.Message{{Role: model.User, Parts: []model.Part{{Text: "Hello"}}}}
			stream, err := provider.Stream(context.Background(), tc.request)
			if err != nil {
				t.Fatal(err)
			}
			stream.Close()
		})
	}
}
