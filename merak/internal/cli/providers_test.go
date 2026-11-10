package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunSelectsProviderThinkingAndReportsReasoningAndCost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	t.Setenv("MERAKCODE_LANG", "en")
	t.Setenv("ZHIPU_API_KEY", "fixture-key")
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Error("provider key was not used")
		}
		requests <- body
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"Check.\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":100,\"prompt_tokens_details\":{\"cached_tokens\":200}}}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	var output bytes.Buffer
	code := Run([]string{"run", "--provider", "zhipu", "--model", "glm-5.3", "--thinking", "xhigh", "--base-url", server.URL, "Begin"}, strings.NewReader(""), &output)
	if code != 0 {
		t.Fatalf("code=%d output=%q", code, output.String())
	}
	body := <-requests
	if body["reasoning_effort"] != "high" || body["model"] != "glm-5.3" {
		t.Fatalf("body=%v", body)
	}
	if got := output.String(); !strings.Contains(got, "Thinking: Check.\nDone.\n") || !strings.Contains(got, "Estimated cost: CNY 0.009600") {
		t.Fatalf("output=%q", got)
	}
}

func TestModelsRefreshKeepsFileOverrides(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path=%s", r.URL.Path)
		}
		fmt.Fprint(w, `{"data":[{"id":"custom-live","max_input_tokens":200000,"max_tokens":64000}],"has_more":false}`)
	}))
	defer host.Close()
	t.Setenv("ANTHROPIC_BASE_URL", host.URL)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("OPENROUTER_BASE_URL", "")
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(`[{"provider":"anthropic","id":"custom-live","window":180000}]`), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := Run([]string{"models", "--refresh", "--overrides", path}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("code=%d", code)
	}
	var entries []catalog.Model
	if err := json.Unmarshal(output.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.ID == "custom-live" {
			if entry.Window != 180000 || entry.MaxOutput != 64000 || entry.Source != "override" {
				t.Fatalf("model=%+v", entry)
			}
			return
		}
	}
	t.Fatal("refreshed model missing")
}

func TestRunConnectsToSecondProtocolAndNewCompatibleProviders(t *testing.T) {
	for _, provider := range []string{"anthropic", "deepseek-anthropic", "gemini", "openrouter"} {
		t.Run(provider, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("MERAKCODE_HOME", home)
			cleanupEngine(t, home)
			requests := make(chan string, 1)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r.URL.Path
				w.Header().Set("Content-Type", "text/event-stream")
				if strings.Contains(provider, "anthropic") {
					fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Ready\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
					return
				}
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Ready\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer host.Close()
			var output bytes.Buffer
			if code := Run([]string{"run", "--provider", provider, "--model", "test", "--base-url", host.URL, "Hello"}, strings.NewReader(""), &output); code != 0 || !strings.Contains(output.String(), "Ready") {
				t.Fatalf("code=%d output=%s", code, output.String())
			}
			want := "/chat/completions"
			if strings.Contains(provider, "anthropic") {
				want = "/v1/messages"
			}
			if path := <-requests; path != want {
				t.Fatalf("path=%s", path)
			}
		})
	}
}

func TestModelsListsSupportedThinkingAndUnknownPrices(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	cleanupEngine(t, home)
	var output bytes.Buffer
	if code := Run([]string{"models"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("code=%d", code)
	}
	var entries []catalog.Model
	if err := json.Unmarshal(output.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, entry := range entries {
		found[entry.Provider] = true
		if len(entry.Thinking) == 0 || entry.Source != "builtin" {
			t.Fatalf("entry=%+v", entry)
		}
	}
	for _, name := range []string{"openai", "deepseek", "moonshot", "zhipu", "dashscope", "anthropic", "gemini"} {
		if !found[name] {
			t.Errorf("missing %s", name)
		}
	}
}
