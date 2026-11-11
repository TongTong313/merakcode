package server_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/store"
	storememory "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// catalogFixture runs fake provider and public-catalog services and a configuration file that uses them.
type catalogFixture struct {
	home                 string
	provider, public     *httptest.Server
	providerRequests     atomic.Int32
	publicRequests       atomic.Int32
	providerKey, keyUsed atomic.Value
}

func newCatalogFixture(t *testing.T) *catalogFixture {
	t.Helper()
	f := &catalogFixture{home: t.TempDir()}
	f.provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.providerRequests.Add(1)
		f.keyUsed.Store(r.Header.Get("Authorization"))
		var items []string
		for i := range 27 {
			items = append(items, fmt.Sprintf(`{"id":"qwen-test-%d"}`, i))
		}
		items = append(items, `{"id":"text-embedding-v4"}`, `{"id":"gte-rerank-v2"}`, `{"id":"cosyvoice-tts-v1"}`)
		io.WriteString(w, `{"data":[`+strings.Join(items, ",")+`]}`)
	}))
	f.public = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.publicRequests.Add(1)
		io.WriteString(w, `{"data":[{"id":"alibaba/qwen-test-3","context_length":128000,"deprecated":true,"pricing":{"prompt":"0.000001","completion":"0.000004"}}]}`)
	}))
	t.Cleanup(f.provider.Close)
	t.Cleanup(f.public.Close)
	file := fmt.Sprintf(`{"provider":{"dashscope":{"options":{"baseURL":%q,"apiKey":"k"}}}}`, f.provider.URL)
	if err := os.WriteFile(filepath.Join(f.home, "merakcode.json"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	return f
}

// start hosts an engine on the fixture; stop closes it and returns when its background work has ended.
func (f *catalogFixture) start(t *testing.T, storage store.Store, now func() time.Time) (*protocol.Client, <-chan event.Event, func()) {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: f.home, Store: storage, Now: now, Catalog: catalog.New(catalog.Options{PublicURL: f.public.URL})})
	if err != nil {
		t.Fatal(err)
	}
	facts, stopFacts := e.Bus.Subscribe(event.Filter{Types: []event.Type{catalog.Refreshed, catalog.Failed}})
	instance, err := server.StartWith(e, server.Options{Data: filepath.Join(f.home, "data"), Config: f.home, Address: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	client, err := protocol.Connect(t.Context(), instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	return client, facts, func() { stopFacts(); client.Close(); instance.Close(); e.Close() }
}

func dashscopeModels(t *testing.T, client *protocol.Client) []catalog.Model {
	t.Helper()
	var all, result []catalog.Model
	if err := client.Call(t.Context(), "model.list", protocol.ModelListParams{}, &all); err != nil {
		t.Fatal(err)
	}
	for _, m := range all {
		if m.Provider == "dashscope" {
			result = append(result, m)
		}
	}
	return result
}

func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for " + what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestConfiguredProviderListsAppearWithoutAManualRefresh(t *testing.T) {
	t.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "")
	f := newCatalogFixture(t)
	client, _, stop := f.start(t, storememory.New(), time.Now)
	defer stop()
	eventually(t, "27 dashscope models", func() bool { return len(dashscopeModels(t, client)) == 27 })
	for _, m := range dashscopeModels(t, client) {
		if m.ID == "qwen-test-3" && (m.Window != 128000 || !m.Deprecated || m.Price.Input != 1) {
			t.Fatalf("the public catalog was not merged: %+v", m)
		}
	}
}

func TestListsSurviveARestartAndFailuresAreReported(t *testing.T) {
	t.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "")
	f := newCatalogFixture(t)
	shared := storememory.New()
	start := time.Now()
	client, _, stop := f.start(t, shared, func() time.Time { return start })
	eventually(t, "the first lists", func() bool { return len(dashscopeModels(t, client)) == 27 })
	stop()

	// within the hour, a restart is served from the cache without a request
	requests := f.providerRequests.Load() + f.publicRequests.Load()
	client, _, stop = f.start(t, shared, func() time.Time { return start.Add(30 * time.Minute) })
	eventually(t, "the cached list", func() bool { return len(dashscopeModels(t, client)) == 27 })
	time.Sleep(300 * time.Millisecond)
	stop()
	if got := f.providerRequests.Load() + f.publicRequests.Load(); got != requests {
		t.Fatalf("a fresh cache sent %d requests", got-requests)
	}

	// with both services gone and the cache stale, the list stays and each source reports one failure
	f.provider.Close()
	f.public.Close()
	client, facts, stop := f.start(t, shared, func() time.Time { return start.Add(3 * time.Hour) })
	defer stop()
	failed := map[string]string{}
	deadline := time.After(5 * time.Second)
	for len(failed) < 2 {
		select {
		case fact := <-facts:
			notice, err := event.Decode[catalog.Notice](fact)
			if err != nil || fact.Type != catalog.Failed {
				t.Fatalf("unexpected event %s: %v", fact.Type, err)
			}
			failed[notice.Provider] = notice.Code
		case <-deadline:
			t.Fatalf("failures = %v", failed)
		}
	}
	if failed["dashscope"] != "MRK-2001" || failed["public"] != "MRK-2001" {
		t.Fatalf("failures = %v", failed)
	}
	if len(dashscopeModels(t, client)) != 27 {
		t.Fatal("the cached list was lost while offline")
	}
}

func TestChangingOneKeyRefreshesOnlyThatProvider(t *testing.T) {
	t.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "")
	f := newCatalogFixture(t)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":[{"id":"kimi-test"}]}`)
	}))
	defer other.Close()
	var moonshotRequests atomic.Int32
	moonshot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		moonshotRequests.Add(1)
		io.WriteString(w, `{"data":[{"id":"kimi-test"}]}`)
	}))
	defer moonshot.Close()
	file := fmt.Sprintf(`{"provider":{"dashscope":{"options":{"baseURL":%q,"apiKey":"k"}},"moonshot":{"options":{"baseURL":%q,"apiKey":"one"}}}}`, f.provider.URL, moonshot.URL)
	if err := os.WriteFile(filepath.Join(f.home, "merakcode.json"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	client, _, stop := f.start(t, storememory.New(), time.Now)
	defer stop()
	eventually(t, "both providers", func() bool { return f.providerRequests.Load() == 1 && moonshotRequests.Load() == 1 })
	var settings protocol.Config
	if err := client.Call(t.Context(), "config.set", map[string]any{"providers": map[string]any{"moonshot": map[string]any{"apiKey": "two"}}}, &settings); err != nil {
		t.Fatal(err)
	}
	eventually(t, "moonshot to be fetched again", func() bool { return moonshotRequests.Load() == 2 })
	time.Sleep(300 * time.Millisecond)
	if f.providerRequests.Load() != 1 {
		t.Fatalf("dashscope was fetched %d times", f.providerRequests.Load())
	}
}

func TestDisablingCatalogFetchSendsNoRequest(t *testing.T) {
	t.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "1")
	f := newCatalogFixture(t)
	_, _, stop := f.start(t, storememory.New(), time.Now)
	defer stop()
	time.Sleep(500 * time.Millisecond)
	if f.providerRequests.Load()+f.publicRequests.Load() != 0 {
		t.Fatal("a request was sent")
	}
}

func TestAKeyInTheEnvironmentAlsoConfiguresAProvider(t *testing.T) {
	t.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "")
	f := newCatalogFixture(t)
	if err := os.WriteFile(filepath.Join(f.home, "merakcode.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DASHSCOPE_API_KEY", "from-environment")
	t.Setenv("DASHSCOPE_BASE_URL", f.provider.URL)
	client, _, stop := f.start(t, storememory.New(), time.Now)
	defer stop()
	eventually(t, "27 dashscope models", func() bool { return len(dashscopeModels(t, client)) == 27 })
	if f.keyUsed.Load() != "Bearer from-environment" {
		t.Fatalf("authorization = %v", f.keyUsed.Load())
	}
}
