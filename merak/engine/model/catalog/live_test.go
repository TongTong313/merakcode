package catalog_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

// openAIList serves an OpenAI-compatible model list: 27 chat models and three that cannot chat.
func openAIList(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var items []string
		for i := range 27 {
			items = append(items, fmt.Sprintf(`{"id":"qwen-test-%d"}`, i))
		}
		items = append(items, `{"id":"text-embedding-v4"}`, `{"id":"gte-rerank-v2"}`, `{"id":"cosyvoice-tts-v1"}`)
		io.WriteString(w, `{"data":[`+strings.Join(items, ",")+`]}`)
	}))
}

func providerModels(c *catalog.Catalog, provider string) []catalog.Model {
	var result []catalog.Model
	for _, m := range c.List() {
		if m.Provider == provider {
			result = append(result, m)
		}
	}
	return result
}

func TestLiveListReplacesTheBuiltinListAndSkipsModelsThatCannotChat(t *testing.T) {
	host := openAIList(t)
	defer host.Close()
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "dashscope", Protocol: "openai", BaseURL: host.URL, APIKey: "k"}}})
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	listed := providerModels(c, "dashscope")
	if len(listed) != 27 {
		t.Fatalf("dashscope models = %d, want 27", len(listed))
	}
	for _, m := range listed {
		if m.Source != "live" {
			t.Fatalf("model %s has source %q", m.ID, m.Source)
		}
	}
	if builtin := c.Get("dashscope", "qwen3.5-plus"); builtin.Window != 1000000 {
		t.Fatalf("a model outside the live list stopped resolving: %+v", builtin)
	}
}
