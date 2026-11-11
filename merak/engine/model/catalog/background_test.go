package catalog_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

// publicList serves the public catalog with one entry that matches qwen-test-3 of openAIList.
func publicList(requests *atomic.Int32) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		io.WriteString(w, `{"data":[{"id":"alibaba/qwen-test-3","context_length":128000,"deprecated":true,"pricing":{"prompt":"0.000001","completion":"0.000004"}}]}`)
	}))
}

func TestThePublicCatalogFillsWhatTheProviderListLeavesOut(t *testing.T) {
	host := openAIList(t)
	defer host.Close()
	var requests atomic.Int32
	public := publicList(&requests)
	defer public.Close()
	c := catalog.New(catalog.Options{PublicURL: public.URL, Sources: []catalog.Source{{Provider: "dashscope", Protocol: "openai", BaseURL: host.URL, APIKey: "k"}}})
	notified := make(chan string, 4)
	if err := c.Attach(t.Context(), catalog.Hooks{Notify: func(provider string, err error) {
		if err == nil {
			notified <- provider
		}
	}}); err != nil {
		t.Fatal(err)
	}
	go c.Run(t.Context())
	c.ConfigureSources([]catalog.Source{{Provider: "dashscope", Protocol: "openai", BaseURL: host.URL, APIKey: "k"}})
	for range 2 {
		select {
		case <-notified:
		case <-time.After(5 * time.Second):
			t.Fatal("the lists were not fetched in the background")
		}
	}
	got := c.Get("dashscope", "qwen-test-3")
	if got.Window != 128000 || !got.Deprecated || got.Price.Input != 1 || got.Price.Output != 4 || got.Price.Currency != "USD" {
		t.Fatalf("public data missing: %+v", got)
	}
	if other := c.Get("dashscope", "qwen-test-4"); other.Deprecated || other.Source != "live" {
		t.Fatalf("other=%+v", other)
	}
}

func TestClaudeModelsWithoutLevelsGetThemFromTheFallbackTable(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":[{"id":"claude-opus-4-8-20261001"},{"id":"claude-opus-5-5-20261101"}],"has_more":false}`)
	}))
	defer host.Close()
	c := catalog.New(catalog.Options{Sources: []catalog.Source{{Provider: "anthropic", Protocol: "anthropic", BaseURL: host.URL, APIKey: "k"}}})
	if err := c.Refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	opus := c.Get("anthropic", "claude-opus-4-8-20261001")
	want := []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax}
	if !reflect.DeepEqual(opus.Thinking, want) || opus.DefaultThinking != model.ThinkingHigh {
		t.Fatalf("opus=%+v", opus)
	}
	if fixed := c.Get("anthropic", "claude-opus-5-5-20261101"); fixed.Thinking[0] != model.ThinkingLow || fixed.DefaultThinking != model.ThinkingMedium {
		t.Fatalf("a model that cannot be switched off lists off: %+v", fixed)
	}
	if relay := c.Get("relay", "anthropic/claude-opus-4-8"); relay.DefaultThinking != model.ThinkingHigh {
		t.Fatalf("relay=%+v", relay)
	}
}

// memoryCache is a Cache that keeps snapshots in a map.
type memoryCache struct {
	mu    sync.Mutex
	items map[string]catalog.Snapshot
}

func (m *memoryCache) Load(context.Context) (map[string]catalog.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := map[string]catalog.Snapshot{}
	for key, value := range m.items {
		result[key] = value
	}
	return result, nil
}

func (m *memoryCache) Save(_ context.Context, key string, snapshot catalog.Snapshot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.items == nil {
		m.items = map[string]catalog.Snapshot{}
	}
	m.items[key] = snapshot
	return nil
}

type clock struct{ now atomic.Pointer[time.Time] }

func (c *clock) Now() time.Time { return *c.now.Load() }
func (c *clock) advance(d time.Duration) {
	next := c.Now().Add(d)
	c.now.Store(&next)
}

func newClock() *clock {
	c := &clock{}
	start := time.Date(2026, 11, 11, 8, 0, 0, 0, time.UTC)
	c.now.Store(&start)
	return c
}

func start(t *testing.T, cache catalog.Cache, clock *clock, sources []catalog.Source, public string, notify func(string, error)) *catalog.Catalog {
	t.Helper()
	c := catalog.New(catalog.Options{PublicURL: public})
	if err := c.Attach(t.Context(), catalog.Hooks{Cache: cache, Now: clock.Now, Notify: notify}); err != nil {
		t.Fatal(err)
	}
	go c.Run(t.Context())
	c.ConfigureSources(sources)
	return c
}

func waitFor(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestListsSurviveARestartAndAreNotFetchedAgainWhileFresh(t *testing.T) {
	var live atomic.Int32
	lister := openAIList(t)
	defer lister.Close()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		live.Add(1)
		lister.Config.Handler.ServeHTTP(w, r)
	}))
	var publicRequests atomic.Int32
	public := publicList(&publicRequests)
	cache, clock := &memoryCache{}, newClock()
	sources := []catalog.Source{{Provider: "dashscope", Protocol: "openai", BaseURL: host.URL, APIKey: "k"}}
	events := make(chan string, 16)
	notify := func(provider string, err error) {
		if err != nil {
			events <- "failed:" + provider
			return
		}
		events <- "refreshed:" + provider
	}

	first := start(t, cache, clock, sources, public.URL, notify)
	waitFor(t, "the first fetch", func() bool {
		return len(providerModels(first, "dashscope")) == 27 && first.Get("dashscope", "qwen-test-3").Window == 128000
	})

	// a restart within the hour reads the cache and sends no request
	before, publicBefore := live.Load(), publicRequests.Load()
	clock.advance(30 * time.Minute)
	second := start(t, cache, clock, sources, public.URL, notify)
	waitFor(t, "the cached list", func() bool { return len(providerModels(second, "dashscope")) == 27 })
	time.Sleep(300 * time.Millisecond)
	if live.Load() != before || publicRequests.Load() != publicBefore {
		t.Fatalf("a fresh cache was fetched again: %d live, %d public requests", live.Load()-before, publicRequests.Load()-publicBefore)
	}

	// offline and stale: the list stays, and each failing source reports once
	host.Close()
	public.Close()
	clock.advance(2 * time.Hour)
	for len(events) > 0 {
		<-events
	}
	third := start(t, cache, clock, sources, public.URL, notify)
	failed := map[string]int{}
	waitFor(t, "two failures", func() bool {
		for len(events) > 0 {
			failed[<-events]++
		}
		return failed["failed:dashscope"] == 1 && failed["failed:public"] == 1
	})
	if len(providerModels(third, "dashscope")) != 27 || third.Get("dashscope", "qwen-test-3").Window != 128000 {
		t.Fatal("the cached list was lost while offline")
	}
}

func TestOnlyTheProviderWhoseKeyChangedIsRefreshed(t *testing.T) {
	counts := map[string]*atomic.Int32{"moonshot": {}, "deepseek": {}}
	hosts := map[string]*httptest.Server{}
	for name, count := range counts {
		hosts[name] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			count.Add(1)
			io.WriteString(w, `{"data":[{"id":"chat-model"}]}`)
		}))
		defer hosts[name].Close()
	}
	var publicRequests atomic.Int32
	public := publicList(&publicRequests)
	defer public.Close()
	sources := func(moonshotKey string) []catalog.Source {
		return []catalog.Source{
			{Provider: "moonshot", Protocol: "openai", BaseURL: hosts["moonshot"].URL, APIKey: moonshotKey},
			{Provider: "deepseek", Protocol: "openai", BaseURL: hosts["deepseek"].URL, APIKey: "same"},
		}
	}
	c := start(t, &memoryCache{}, newClock(), sources("one"), public.URL, nil)
	waitFor(t, "both providers", func() bool { return counts["moonshot"].Load() == 1 && counts["deepseek"].Load() == 1 })
	c.ConfigureSources(sources("two"))
	waitFor(t, "the changed provider", func() bool { return counts["moonshot"].Load() == 2 })
	time.Sleep(300 * time.Millisecond)
	if counts["deepseek"].Load() != 1 || counts["moonshot"].Load() != 2 {
		t.Fatalf("moonshot=%d deepseek=%d", counts["moonshot"].Load(), counts["deepseek"].Load())
	}
}

func TestDisabledBackgroundFetchSendsNoRequest(t *testing.T) {
	var requests atomic.Int32
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer host.Close()
	c := catalog.New(catalog.Options{PublicURL: host.URL})
	if err := c.Attach(t.Context(), catalog.Hooks{Disabled: true}); err != nil {
		t.Fatal(err)
	}
	go c.Run(t.Context())
	c.ConfigureSources([]catalog.Source{{Provider: "openai", Protocol: "openai", BaseURL: host.URL, APIKey: "k"}})
	time.Sleep(300 * time.Millisecond)
	if requests.Load() != 0 {
		t.Fatalf("requests=%d", requests.Load())
	}
}
