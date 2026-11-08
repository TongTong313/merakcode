package catalog_test

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

func TestRefreshMergesPublishedFieldsAndKeepsUserOverrides(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("after_id") == "claude-new" {
			io.WriteString(w, `{"data":[{"id":"claude-next","max_input_tokens":300000}],"has_more":false}`)
			return
		}
		io.WriteString(w, `{"data":[{"id":"claude-new","max_input_tokens":200000,"max_tokens":64000,"capabilities":{"image_input":{"supported":true},"pdf_input":{"supported":true},"thinking":{"types":{"disabled":{"supported":true}}},"effort":{"low":{"supported":true},"high":{"supported":true}}}}],"has_more":true,"last_id":"claude-new"}`)
	}))
	defer host.Close()
	window := 180000
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "anthropic", BaseURL: host.URL, APIKey: "test-key"}}, Overrides: []catalog.Override{{Provider: "anthropic", ID: "claude-new", Window: &window, Price: &catalog.Price{Input: 2, Output: 10, Currency: "USD"}}}})
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := c.Get("anthropic", "claude-new")
	if got.Window != 180000 || got.MaxOutput != 64000 || !got.Caps.Vision || !got.Caps.PDF || got.Source != "override" || !reflect.DeepEqual(got.Thinking, []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingHigh}) {
		t.Fatalf("merged=%+v", got)
	}
	if cost := got.Price.Apply(model.Usage{Input: 1000000, Output: 100000}); !cost.CostKnown || cost.Cost != 3 {
		t.Fatalf("cost=%+v", cost)
	}
	if next := c.Get("anthropic", "claude-next"); next.Window != 300000 || next.MaxOutput != 8192 || next.Price.Currency != "" {
		t.Fatalf("next=%+v", next)
	}
	if relay := c.Get("relay", "anthropic/claude-next"); relay.Window != 300000 {
		t.Fatalf("relay=%+v", relay)
	}
}

func TestOpenRouterRefreshConvertsRatesAndRetainsDataOnFailure(t *testing.T) {
	var fail atomic.Bool
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/models" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		io.WriteString(w, `{"data":[{"id":"vendor/test-model","context_length":250000,"top_provider":{"max_completion_tokens":32000},"pricing":{"prompt":"0.000002","completion":"0.000008","input_cache_read":"0.0000002","input_cache_write":"0.0000025"},"architecture":{"input_modalities":["text","image","file"]},"supported_parameters":["tools","reasoning"]}]}`)
	}))
	defer host.Close()
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "openrouter", BaseURL: host.URL + "/api/v1"}}})
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := c.Get("openrouter", "vendor/test-model")
	if want.Window != 250000 || want.MaxOutput != 32000 || want.Price.Input != 2 || want.Price.Output != 8 || math.Abs(want.Price.CacheRead-.2) > 1e-12 || want.Price.CacheWrite != 2.5 || !want.Caps.Tools || !want.Caps.Vision || !want.Caps.PDF {
		t.Fatalf("model=%+v", want)
	}
	fail.Store(true)
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("refresh hid failure")
	}
	if got := c.Get("openrouter", "vendor/test-model"); !reflect.DeepEqual(got, want) {
		t.Fatalf("failure changed catalog: %+v", got)
	}
}

func TestCompatibleAnthropicDiscoveryPaginatesAnExplicitVersionedEndpoint(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("x-api-key") != "draft-key" {
			t.Errorf("unexpected discovery request: %s", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.URL.Query().Get("after_id") == "first" {
			io.WriteString(w, `{"data":[{"id":"second","max_input_tokens":64000}],"has_more":false}`)
			return
		}
		io.WriteString(w, `{"data":[{"id":"first"}],"has_more":true,"last_id":"first"}`)
	}))
	defer host.Close()
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "relay", Protocol: "anthropic", BaseURL: host.URL + "/v1", APIKey: "draft-key"}}})
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.Get("relay", "second").Window != 64000 {
		t.Fatal("second page was not discovered")
	}
}
