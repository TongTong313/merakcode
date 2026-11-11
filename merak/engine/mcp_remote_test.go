package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

// remoteMCP is a remote MCP server that wants a login and has its own authorization server on the same host.
type remoteMCP struct {
	mu     sync.Mutex
	host   string
	issued string
	state  string
}

func (r *remoteMCP) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	answer := func(value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(value)
	}
	switch req.URL.Path {
	case "/.well-known/oauth-protected-resource":
		answer(map[string]any{"authorization_servers": []string{r.host}})
	case "/.well-known/oauth-authorization-server":
		answer(map[string]any{"authorization_endpoint": r.host + "/authorize", "token_endpoint": r.host + "/token", "registration_endpoint": r.host + "/register"})
	case "/register":
		w.WriteHeader(http.StatusCreated)
		answer(map[string]any{"client_id": "engine-client"})
	case "/token":
		r.mu.Lock()
		r.issued = "engine-token"
		r.mu.Unlock()
		answer(map[string]any{"access_token": "engine-token", "refresh_token": "r", "expires_in": 3600})
	case "/mcp":
		r.mu.Lock()
		allowed := r.issued != "" && req.Header.Get("Authorization") == "Bearer "+r.issued
		r.mu.Unlock()
		if !allowed {
			w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+r.host+`/.well-known/oauth-protected-resource"`)
			http.Error(w, "login", http.StatusUnauthorized)
			return
		}
		body, _ := io.ReadAll(req.Body)
		var call struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(body, &call)
		reply := func(result any) {
			data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": call.ID, "result": result})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(data)
		}
		switch call.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s")
			reply(map[string]any{"protocolVersion": mcp.Version, "capabilities": map[string]any{"tools": map[string]any{}}})
		case "tools/list":
			reply(map[string]any{"tools": []map[string]any{{"name": "search", "inputSchema": map[string]any{"type": "object"}}, {"name": "fetch", "inputSchema": map[string]any{"type": "object"}}}})
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}
}

func TestARemoteServerShowsNeedsAuthLogsInThroughTheBrowserAndLogsOut(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	remote := &remoteMCP{}
	host := httptest.NewServer(remote)
	defer host.Close()
	remote.host = host.URL
	root := t.TempDir()
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	broken := config.MCPServer{Type: "remote", URL: "http://127.0.0.1:1/mcp", Timeout: 1500}
	off := config.MCPServer{Type: "remote", URL: host.URL + "/mcp", Disabled: true}
	_, err = settings.Update(config.Patch{MCP: map[string]*config.MCPServer{
		"remote": {Type: "remote", URL: host.URL + "/mcp"}, "broken": &broken, "off": &off,
	}})
	if err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Vault: credential.NewFile(t.TempDir()), NetworkSettings: settings, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Done.", Expect: func(req model.Request) error {
		if !strings.Contains(req.System, "mcp__remote__search") || !strings.Contains(req.System, "mcp__remote__fetch") {
			return fmt.Errorf("the deferred tools of the remote server are not offered: %s", req.System)
		}
		return nil
	}})}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()

	byName := func() map[string]engine.MCPStatus {
		t.Helper()
		statuses, err := e.MCPStatus(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		result := map[string]engine.MCPStatus{}
		for _, status := range statuses {
			result[status.Name] = status
		}
		return result
	}
	before := byName()
	if before["remote"].Status != "needs_auth" || before["off"].Status != "disabled" || before["broken"].Status != "failed" || before["broken"].Code != "MRK-5010" {
		t.Fatalf("before the login: %+v", before)
	}

	changes, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{engine.MCPChanged}})
	defer stop()
	authorizeURL, err := e.MCPAuthenticate(ctx, "remote")
	if err != nil {
		t.Fatal(err)
	}
	address, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	redirect := address.Query().Get("redirect_uri")
	response, err := http.Get(redirect + "?code=c&state=" + address.Query().Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	select {
	case fact := <-changes:
		var change engine.MCPChange
		if err := json.Unmarshal(fact.Payload, &change); err != nil || change.Server != "remote" || change.Code != "" {
			t.Fatalf("change=%+v err=%v", change, err)
		}
	case <-ctx.Done():
		t.Fatal("no mcp.changed after the login")
	}
	after := byName()
	if after["remote"].Status != "connected" || after["remote"].Tools != 2 {
		t.Fatalf("after the login: %+v", after["remote"])
	}

	// A new conversation offers the tools of the logged-in server, deferred.
	id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	finished, stopTurn := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{"turn.finished"}})
	defer stopTurn()
	if err := e.Send(ctx, id, []model.Part{{Text: "Hello"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-ctx.Done():
		t.Fatal("the turn did not finish")
	}

	if err := e.MCPLogout(ctx, "remote"); err != nil {
		t.Fatal(err)
	}
	if status := byName()["remote"]; status.Status != "needs_auth" {
		t.Fatalf("after the logout: %+v", status)
	}
}

func TestALocalServerIsProbedForItsToolCountAndAWorkspaceServerWaitsForTrust(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	binary := buildMCPFixture(t)
	root := t.TempDir()
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Update(config.Patch{MCP: map[string]*config.MCPServer{"local": {Command: binary}}}); err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	writeFile(t, project+"/merakcode.json", `{"mcp":{"project":{"type":"local","command":[`+jsonString(binary)+`]}}}`)
	e, err := engine.New(engine.Deps{Workdir: project, NetworkSettings: settings, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	statuses, err := e.MCPStatus(ctx, project)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, status := range statuses {
		names = append(names, status.Name+"="+status.Status)
		if status.Name == "local" && (status.Status != "connected" || status.Tools < 1) {
			t.Fatalf("local=%+v", status)
		}
	}
	slices.Sort(names)
	if !slices.Contains(names, "project=disabled") || !slices.Contains(names, "local=connected") {
		t.Fatalf("statuses=%v", strings.Join(names, ","))
	}
}

func buildMCPFixture(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "localserver.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./mcp/testdata/localserver").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	return binary
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func jsonString(value string) string {
	body, _ := json.Marshal(value)
	return string(body)
}

func buildPromptServer(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "promptserver.exe")
	if out, err := process.Command(t.Context(), "", "go", "build", "-o", binary, "./mcp/testdata/promptserver").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	return binary
}

func turnFilter(session event.ID) event.Filter {
	return event.Filter{Scope: event.Scope{Session: session}, Types: []event.Type{"turn.finished"}}
}
