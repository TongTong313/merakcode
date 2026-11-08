package server_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestConfiguredRelayDiscoveryUsesSecretHeaders(t *testing.T) {
	called := make(chan struct{}, 1)
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Route") != "private-routing-key" || r.Header.Get("X-Api-Key") != "provider-key" {
			t.Error("relay authentication missing")
		}
		if r.Method == http.MethodGet {
			if r.URL.Path != "/models" {
				t.Errorf("discovery path=%s", r.URL.Path)
			}
			io.WriteString(w, `{"data":[{"id":"gpt-4o"},{"id":"local-model","context_length":96000}]}`)
			return
		}
		called <- struct{}{}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Ready\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer host.Close()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var value config.Value
	provider := config.Provider{Protocol: "openai", BaseURL: host.URL, APIKey: "provider-key", Auth: "x-api-key", Headers: map[string]string{"X-Route": "private-routing-key"}, Station: "station", Group: "group", Picker: &config.Picker{Exclude: []string{"gpt-4o"}}}
	if err := client.Call(ctx, "config.set", config.Patch{Providers: map[string]*config.Provider{"relay": &provider}}, &value); err != nil {
		t.Fatal(err)
	}
	public := value.Providers["relay"]
	if len(public.Headers) != 0 || !public.HasHeaders || public.APIKey != "" || public.Station != "station" {
		t.Fatalf("public config is unsafe or incomplete: %+v", public)
	}
	public.Name = "Renamed group"
	if err := client.Call(ctx, "config.set", config.Patch{Providers: map[string]*config.Provider{"relay": &public}}, &value); err != nil {
		t.Fatal(err)
	}
	if saved := value.Providers["relay"].Picker; saved == nil || len(saved.Exclude) != 1 || saved.Exclude[0] != "gpt-4o" {
		t.Fatal("model picker preferences did not survive provider rename")
	}
	var models []catalog.Model
	if err := client.Call(ctx, "model.refresh", protocol.ModelRefreshParams{Provider: "relay"}, &models); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range models {
		if item.Provider == "relay" && item.ID == "local-model" && item.Window == 96000 {
			found = true
		}
	}
	if !found {
		t.Fatal("relay discovery omitted published model limits")
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: "relay", Model: "gpt-4o"}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", map[string]any{"session": created.Session, "parts": []map[string]string{{"text": "Hello"}}}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-called:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDraftRelayDiscoveryDoesNotSaveConfiguration(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("X-Route") != "draft-secret" {
			t.Error("draft discovery lost its endpoint or headers")
		}
		io.WriteString(w, `{"data":[{"id":"draft-only","context_length":64000}]}`)
	}))
	defer host.Close()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var models []catalog.Model
	params := map[string]any{"provider": config.Provider{Protocol: "openai", BaseURL: host.URL + "/v1", Headers: map[string]string{"X-Route": "draft-secret"}}}
	if err := client.Call(ctx, "model.discover", params, &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "draft-only" || models[0].Window != 64000 {
		t.Fatalf("discovery=%+v", models)
	}
	var value config.Value
	if err := client.Call(ctx, "config.get", struct{}{}, &value); err != nil {
		t.Fatal(err)
	}
	for _, provider := range value.Providers {
		if provider.BaseURL == host.URL+"/v1" || provider.HasHeaders {
			t.Fatal("draft discovery saved configuration")
		}
	}
	if err := client.Call(ctx, "model.list", struct{}{}, &models); err != nil {
		t.Fatal(err)
	}
	for _, item := range models {
		if item.ID == "draft-only" {
			t.Fatal("draft discovery changed the shared catalog")
		}
	}
}
