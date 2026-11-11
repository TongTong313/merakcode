package mcp_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
)

// authority is an MCP resource and its authorization server on one host.
type authority struct {
	mu          sync.Mutex
	host        string
	registered  []map[string]any
	challenge   string
	redirect    string
	issued      int
	refreshes   atomic.Int32
	expiresIn   int
	accessToken string
}

func (a *authority) token() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.accessToken
}

func (a *authority) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	json200 := func(value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(value)
	}
	switch r.URL.Path {
	case "/.well-known/oauth-protected-resource":
		json200(map[string]any{"resource": a.host + "/mcp", "authorization_servers": []string{a.host}})
	case "/.well-known/oauth-authorization-server":
		json200(map[string]any{
			"issuer": a.host, "authorization_endpoint": a.host + "/authorize", "token_endpoint": a.host + "/token",
			"registration_endpoint": a.host + "/register", "code_challenge_methods_supported": []string{"S256"},
		})
	case "/register":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		a.mu.Lock()
		a.registered = append(a.registered, body)
		a.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		json200(map[string]any{"client_id": "registered-client"})
	case "/token":
		_ = r.ParseForm()
		a.mu.Lock()
		defer a.mu.Unlock()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			verifier := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("code") != "the-code" || base64.RawURLEncoding.EncodeToString(verifier[:]) != a.challenge || r.Form.Get("redirect_uri") != a.redirect || r.Form.Get("client_id") == "" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
		case "refresh_token":
			if r.Form.Get("refresh_token") != "refresh-1" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			a.refreshes.Add(1)
		default:
			http.Error(w, `{"error":"unsupported_grant_type"}`, http.StatusBadRequest)
			return
		}
		a.issued++
		a.accessToken = "access-" + string(rune('0'+a.issued))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": a.accessToken, "refresh_token": "refresh-1", "expires_in": a.expiresIn, "token_type": "Bearer"})
	}
}

func TestALoginDiscoversRegistersAndTradesTheCodeForTokensThatRefreshOnTheirOwn(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	a := &authority{expiresIn: 3600}
	host := httptest.NewServer(a)
	defer host.Close()
	a.host = host.URL
	vault := credential.NewFile(t.TempDir())
	login := &mcp.Login{Vault: vault}

	// The "browser" opens the address the login returns and follows the redirect to the callback.
	authorizeURL, finished, err := login.Begin(ctx, "remote", host.URL+"/mcp", &mcp.AuthRequired{}, config.MCPServer{Type: "remote", URL: host.URL + "/mcp"})
	if err != nil {
		t.Fatal(err)
	}
	address, err := url.Parse(authorizeURL)
	if err != nil || address.Path != "/authorize" {
		t.Fatalf("authorize address %q err=%v", authorizeURL, err)
	}
	query := address.Query()
	if query.Get("response_type") != "code" || query.Get("code_challenge_method") != "S256" || query.Get("client_id") != "registered-client" || query.Get("state") == "" || query.Get("resource") != host.URL+"/mcp" {
		t.Fatalf("authorize query=%v", query)
	}
	a.mu.Lock()
	a.challenge, a.redirect = query.Get("code_challenge"), query.Get("redirect_uri")
	a.mu.Unlock()
	if u, _ := url.Parse(a.redirect); u.Hostname() != "127.0.0.1" || u.Path != "/callback" {
		t.Fatalf("the callback must be a loopback address: %q", a.redirect)
	}
	wrong, err := http.Get(a.redirect + "?code=the-code&state=wrong")
	if err != nil {
		t.Fatal(err)
	}
	wrong.Body.Close()
	if wrong.StatusCode == http.StatusOK {
		t.Fatal("a callback with the wrong state was accepted")
	}
	callback, err := http.Get(a.redirect + "?code=the-code&state=" + query.Get("state"))
	if err != nil {
		t.Fatal(err)
	}
	callback.Body.Close()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("the login never finished")
	}
	if len(a.registered) != 1 || a.registered[0]["token_endpoint_auth_method"] != "none" {
		t.Fatalf("registrations=%v", a.registered)
	}
	token, err := login.Token(ctx, "remote")
	if err != nil || token != "access-1" {
		t.Fatalf("token=%q err=%v", token, err)
	}
	for _, key := range []string{"mcp:remote"} {
		if body, err := vault.Get(ctx, key); err != nil || len(body) == 0 {
			t.Fatalf("the vault has no %s: %v", key, err)
		}
	}

	// A token that is about to run out is replaced before it is handed out.
	a.mu.Lock()
	a.expiresIn = 1
	a.mu.Unlock()
	login.SetClock(func() time.Time { return time.Now().Add(2 * time.Hour) })
	renewed, err := login.Token(ctx, "remote")
	if err != nil || renewed == "access-1" || a.refreshes.Load() != 1 {
		t.Fatalf("renewed=%q refreshes=%d err=%v", renewed, a.refreshes.Load(), err)
	}

	if err := login.Logout(ctx, "remote"); err != nil {
		t.Fatal(err)
	}
	if token, err := login.Token(ctx, "remote"); err != nil || token != "" {
		t.Fatalf("after the logout token=%q err=%v", token, err)
	}
}

func TestAClientIdFromTheConfigurationSkipsRegistrationAndALoginCanBeAbandoned(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	a := &authority{expiresIn: 3600}
	host := httptest.NewServer(a)
	defer host.Close()
	a.host = host.URL
	login := &mcp.Login{Vault: credential.NewFile(t.TempDir())}
	server := config.MCPServer{Type: "remote", URL: host.URL + "/mcp", OAuth: &config.OAuth{ClientID: "mine", Scope: "read write"}}
	authorizeURL, finished, err := login.Begin(ctx, "remote", server.URL, &mcp.AuthRequired{ResourceMetadata: host.URL + "/.well-known/oauth-protected-resource"}, server)
	if err != nil {
		t.Fatal(err)
	}
	query, _ := url.Parse(authorizeURL)
	if query.Query().Get("client_id") != "mine" || query.Query().Get("scope") != "read write" || len(a.registered) != 0 {
		t.Fatalf("query=%v registrations=%v", query.Query(), a.registered)
	}
	login.Cancel("remote")
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("an abandoned login reported success")
		}
	case <-ctx.Done():
		t.Fatal("an abandoned login never ended")
	}
	if _, _, err := login.Begin(ctx, "remote", "http://127.0.0.1:1/mcp", &mcp.AuthRequired{}, config.MCPServer{Type: "remote", URL: "http://127.0.0.1:1/mcp"}); err == nil {
		t.Fatal("a login against an unreachable server did not fail")
	}
}
