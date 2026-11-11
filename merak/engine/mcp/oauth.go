package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
)

const loginWait = 5 * time.Minute

// Login signs the engine in to remote MCP servers that ask for it: it finds out how the server wants to be logged
// in to (RFC 9728 and RFC 8414), registers the engine as a client when needed (RFC 7591) and trades an authorization
// code, protected by PKCE, for tokens. Tokens live in the vault and renew themselves.
type Login struct {
	Vault credential.Vault
	// Client carries the requests to the servers; nil uses a client with a timeout.
	Client *http.Client

	mu      sync.Mutex
	pending map[string]context.CancelFunc
	now     func() time.Time
}

// SetClock replaces the time source; tests use it to age tokens.
func (l *Login) SetClock(now func() time.Time) {
	l.mu.Lock()
	l.now = now
	l.mu.Unlock()
}

func (l *Login) clock() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

func (l *Login) http() *http.Client {
	if l.Client != nil {
		return l.Client
	}
	return &http.Client{Timeout: 20 * time.Second}
}

// saved is what the vault keeps for one server.
type saved struct {
	AccessToken  string    `json:"accessToken"`
	RefreshToken string    `json:"refreshToken,omitempty"`
	Expires      time.Time `json:"expires,omitempty"`
	TokenURL     string    `json:"tokenUrl"`
	ClientID     string    `json:"clientId"`
	ClientSecret string    `json:"clientSecret,omitempty"`
	Resource     string    `json:"resource,omitempty"`
}

type serverMetadata struct {
	Authorize string   `json:"authorization_endpoint"`
	Token     string   `json:"token_endpoint"`
	Register  string   `json:"registration_endpoint"`
	Methods   []string `json:"code_challenge_methods_supported"`
}

func (l *Login) getJSON(ctx context.Context, address string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := l.http().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", address, response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target)
}

// discover finds the authorization server of an MCP resource.
func (l *Login) discover(ctx context.Context, resource string, auth *AuthRequired) (serverMetadata, error) {
	origin, err := originOf(resource)
	if err != nil {
		return serverMetadata{}, err
	}
	issuer := origin
	metadataAddress := auth.ResourceMetadata
	if metadataAddress == "" {
		metadataAddress = origin + "/.well-known/oauth-protected-resource"
	}
	var protected struct {
		Servers []string `json:"authorization_servers"`
	}
	if err := l.getJSON(ctx, metadataAddress, &protected); err == nil && len(protected.Servers) > 0 {
		issuer = strings.TrimRight(protected.Servers[0], "/")
	}
	var metadata serverMetadata
	var lastErr error
	for _, path := range []string{"/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"} {
		if lastErr = l.getJSON(ctx, issuer+path, &metadata); lastErr == nil && metadata.Authorize != "" && metadata.Token != "" {
			return metadata, nil
		}
	}
	if lastErr == nil {
		lastErr = errors.New("the authorization server did not describe itself")
	}
	return serverMetadata{}, lastErr
}

func originOf(address string) (string, error) {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Host == "" {
		return "", errors.New("invalid MCP address")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func randomText(size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// Begin starts a login. It returns the address the person opens in a browser; the returned channel reports how the
// login ended once the browser comes back to the loopback callback, or after five minutes.
func (l *Login) Begin(ctx context.Context, name, resource string, auth *AuthRequired, server config.MCPServer) (string, <-chan error, error) {
	metadata, err := l.discover(ctx, resource, auth)
	if err != nil {
		return "", nil, err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	redirect := "http://" + listener.Addr().String() + "/callback"
	client := saved{TokenURL: metadata.Token, Resource: resource}
	if server.OAuth != nil && server.OAuth.ClientID != "" {
		client.ClientID, client.ClientSecret = server.OAuth.ClientID, server.OAuth.ClientSecret
	} else if client.ClientID, err = l.register(ctx, metadata, redirect); err != nil {
		listener.Close()
		return "", nil, err
	}
	verifier, err := randomText(48)
	if err != nil {
		listener.Close()
		return "", nil, err
	}
	state, err := randomText(24)
	if err != nil {
		listener.Close()
		return "", nil, err
	}
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {redirect}, "state": {state},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}, "resource": {resource},
	}
	scope := auth.Scope
	if server.OAuth != nil && server.OAuth.Scope != "" {
		scope = server.OAuth.Scope
	}
	if scope != "" {
		query.Set("scope", scope)
	}
	authorize, err := url.Parse(metadata.Authorize)
	if err != nil {
		listener.Close()
		return "", nil, err
	}
	merged := authorize.Query()
	for key, values := range query {
		merged[key] = values
	}
	authorize.RawQuery = merged.Encode()

	runCtx, cancel := context.WithTimeout(context.Background(), loginWait)
	l.mu.Lock()
	if l.pending == nil {
		l.pending = make(map[string]context.CancelFunc)
	}
	if previous := l.pending[name]; previous != nil {
		previous()
	}
	l.pending[name] = cancel
	l.mu.Unlock()
	finished := make(chan error, 1)
	codes := make(chan string, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			http.Error(w, "unexpected state", http.StatusBadRequest)
			return
		}
		if problem := r.URL.Query().Get("error"); problem != "" {
			http.Error(w, "the login was refused", http.StatusBadRequest)
			select {
			case codes <- "":
			default:
			}
			return
		}
		select {
		case codes <- r.URL.Query().Get("code"):
		default:
		}
		_, _ = io.WriteString(w, "You can close this window and go back to MerakCode.")
	})
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = httpServer.Serve(listener) }()
	go func() {
		defer cancel()
		defer func() {
			shutdown, stop := context.WithTimeout(context.Background(), 2*time.Second)
			defer stop()
			_ = httpServer.Shutdown(shutdown)
			l.mu.Lock()
			delete(l.pending, name)
			l.mu.Unlock()
		}()
		select {
		case code := <-codes:
			if code == "" {
				finished <- errors.New("the login was refused")
				return
			}
			finished <- l.exchange(runCtx, name, client, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}, "code_verifier": {verifier}})
		case <-runCtx.Done():
			finished <- errors.New("the login did not finish")
		}
	}()
	return authorize.String(), finished, nil
}

// Cancel abandons a login that is waiting for its browser.
func (l *Login) Cancel(name string) {
	l.mu.Lock()
	cancel := l.pending[name]
	l.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (l *Login) register(ctx context.Context, metadata serverMetadata, redirect string) (string, error) {
	if metadata.Register == "" {
		return "", errors.New("the server has no client registration; set oauth.clientId")
	}
	body, _ := json.Marshal(map[string]any{
		"client_name": "MerakCode", "redirect_uris": []string{redirect}, "grant_types": []string{"authorization_code", "refresh_token"},
		"response_types": []string{"code"}, "token_endpoint_auth_method": "none",
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, metadata.Register, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := l.http().Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var registered struct {
		ClientID string `json:"client_id"`
	}
	if response.StatusCode >= 300 || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&registered) != nil || registered.ClientID == "" {
		return "", errors.New("the server refused the client registration")
	}
	return registered.ClientID, nil
}

// exchange asks the token endpoint for tokens and keeps them.
func (l *Login) exchange(ctx context.Context, name string, client saved, form url.Values) error {
	form.Set("client_id", client.ClientID)
	if client.ClientSecret != "" {
		form.Set("client_secret", client.ClientSecret)
	}
	if client.Resource != "" {
		form.Set("resource", client.Resource)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := l.http().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var issued struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&issued) != nil || issued.AccessToken == "" {
		return errors.New("the server refused the login")
	}
	client.AccessToken, client.RefreshToken = issued.AccessToken, issued.RefreshToken
	if issued.RefreshToken == "" {
		client.RefreshToken = form.Get("refresh_token")
	}
	client.Expires = time.Time{}
	if issued.ExpiresIn > 0 {
		client.Expires = l.clock().Add(time.Duration(issued.ExpiresIn) * time.Second)
	}
	body, err := json.Marshal(client)
	if err != nil {
		return err
	}
	return l.Vault.Set(ctx, "mcp:"+name, body)
}

func (l *Login) load(ctx context.Context, name string) (saved, bool) {
	body, err := l.Vault.Get(ctx, "mcp:"+name)
	if err != nil {
		return saved{}, false
	}
	var value saved
	if json.Unmarshal(body, &value) != nil || value.AccessToken == "" {
		return saved{}, false
	}
	return value, true
}

// Token returns the access token of a server, renewing it first when it is about to run out. A server that was
// never logged in to has no token: the answer is empty, not an error.
func (l *Login) Token(ctx context.Context, name string) (string, error) {
	value, ok := l.load(ctx, name)
	if !ok {
		return "", nil
	}
	if value.Expires.IsZero() || l.clock().Add(time.Minute).Before(value.Expires) {
		return value.AccessToken, nil
	}
	if value.RefreshToken == "" {
		return "", nil
	}
	if err := l.exchange(ctx, name, value, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {value.RefreshToken}}); err != nil {
		return "", nil
	}
	renewed, _ := l.load(ctx, name)
	return renewed.AccessToken, nil
}

// LoggedIn says whether a server has tokens.
func (l *Login) LoggedIn(ctx context.Context, name string) bool {
	_, ok := l.load(ctx, name)
	return ok
}

// Logout forgets the tokens of a server.
func (l *Login) Logout(ctx context.Context, name string) error {
	l.Cancel(name)
	return l.Vault.Delete(ctx, "mcp:"+name)
}
