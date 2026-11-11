package mcp_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type rpc struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func reply(id json.RawMessage, result any) []byte {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	return body
}

// streamable is a Streamable HTTP MCP server with two tools. Tool lists come back as an event stream, the rest as JSON.
type streamable struct {
	mu       sync.Mutex
	sessions int
	seen     []http.Header
	deleted  bool
	token    string
}

func (s *streamable) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.seen = append(s.seen, r.Header.Clone())
	s.mu.Unlock()
	if r.Method == http.MethodDelete {
		s.mu.Lock()
		s.deleted = true
		s.mu.Unlock()
		return
	}
	if s.token != "" && r.Header.Get("Authorization") != "Bearer "+s.token {
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="https://auth.example/.well-known/oauth-protected-resource", scope="read"`)
		http.Error(w, "login", http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var call rpc
	if json.Unmarshal(body, &call) != nil {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	if call.Method != "initialize" && r.Header.Get("Mcp-Session-Id") != "session-1" {
		http.Error(w, "no session", http.StatusBadRequest)
		return
	}
	switch call.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "session-1")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(reply(call.ID, map[string]any{"protocolVersion": mcp.Version, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "fake"}}))
	case "notifications/initialized":
		w.WriteHeader(http.StatusAccepted)
	case "tools/list":
		w.Header().Set("Content-Type", "text/event-stream")
		tools := []map[string]any{
			{"name": "echo", "description": "Echo", "inputSchema": map[string]any{"type": "object"}},
			{"name": "add", "description": "Add", "inputSchema": map[string]any{"type": "object"}},
		}
		fmt.Fprintf(w, "id: 1\nevent: message\ndata: %s\n\n", reply(call.ID, map[string]any{"tools": tools}))
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		_ = json.Unmarshal(call.Params, &params)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(reply(call.ID, map[string]any{"content": []map[string]string{{"type": "text", "text": params.Name + ":" + string(params.Arguments)}}}))
	default:
		http.Error(w, "unknown", http.StatusNotFound)
	}
}

func TestAStreamableHTTPServerListsAndCallsToolsThroughJSONAndEventStreams(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	fake := &streamable{}
	host := httptest.NewServer(fake)
	defer host.Close()
	connection, err := mcp.ConnectHTTP(ctx, "fake", mcp.HTTPOptions{URL: host.URL, Headers: map[string]string{"X-Team": "a"}})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tools, err := connection.Tools(ctx)
	if err != nil || len(tools) != 2 {
		t.Fatalf("tools=%v err=%v", tools, err)
	}
	if name := tools[0].Spec().Name; name != "mcp__fake__echo" {
		t.Fatalf("tool name %q", name)
	}
	result, err := tools[0].Run(ctx, tool.Call{Input: json.RawMessage(`{"x":1}`)})
	if err != nil || result.IsError || len(result.Parts) != 1 || result.Parts[0].Text != `echo:{"x":1}` {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	for _, header := range fake.seen {
		if header.Get("X-Team") != "a" || !strings.Contains(header.Get("Accept"), "text/event-stream") {
			t.Fatalf("a request lacks the configured header or the accept list: %v", header)
		}
	}
}

func TestACredentialIsSentAndALoginDemandIsReportedWithWhatItNeeds(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	fake := &streamable{token: "secret-token"}
	host := httptest.NewServer(fake)
	defer host.Close()

	_, err := mcp.ConnectHTTP(ctx, "fake", mcp.HTTPOptions{URL: host.URL})
	var auth *mcp.AuthRequired
	if !errors.As(err, &auth) || auth.ResourceMetadata != "https://auth.example/.well-known/oauth-protected-resource" || auth.Scope != "read" {
		t.Fatalf("err=%v auth=%+v", err, auth)
	}
	connection, err := mcp.ConnectHTTP(ctx, "fake", mcp.HTTPOptions{URL: host.URL, Token: func(context.Context) (string, error) { return "secret-token", nil }})
	if err != nil {
		t.Fatalf("a request with the credential failed: %v", err)
	}
	if tools, err := connection.Tools(ctx); err != nil || len(tools) != 2 {
		t.Fatalf("tools=%v err=%v", tools, err)
	}
	connection.Close()
	time.Sleep(100 * time.Millisecond)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !fake.deleted {
		t.Fatal("closing the connection did not end the server session")
	}
}

// legacy is the older HTTP+SSE transport: an event stream says where to post, and the answers come back on it.
type legacy struct {
	mu     sync.Mutex
	stream chan []byte
}

func (l *legacy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		fmt.Fprint(w, "event: endpoint\ndata: /messages?session=7\n\n")
		flusher.Flush()
		for {
			select {
			case message := <-l.stream:
				fmt.Fprintf(w, "event: message\ndata: %s\n\n", message)
				flusher.Flush()
			case <-r.Context().Done():
				return
			}
		}
	case r.Method == http.MethodPost && r.URL.Path == "/messages" && r.URL.Query().Get("session") == "7":
		body, _ := io.ReadAll(r.Body)
		var call rpc
		_ = json.Unmarshal(body, &call)
		w.WriteHeader(http.StatusAccepted)
		switch call.Method {
		case "initialize":
			l.stream <- reply(call.ID, map[string]any{"protocolVersion": mcp.Version, "capabilities": map[string]any{"tools": map[string]any{}}})
		case "tools/list":
			l.stream <- reply(call.ID, map[string]any{"tools": []map[string]any{{"name": "old", "inputSchema": map[string]any{"type": "object"}}}})
		}
	default:
		http.Error(w, "this server only speaks the old transport", http.StatusMethodNotAllowed)
	}
}

func TestAServerThatOnlySpeaksTheOlderTransportIsReachedByFallingBack(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	host := httptest.NewServer(&legacy{stream: make(chan []byte, 8)})
	defer host.Close()
	connection, err := mcp.ConnectHTTP(ctx, "old", mcp.HTTPOptions{URL: host.URL + "/sse"})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tools, err := connection.Tools(ctx)
	if err != nil || len(tools) != 1 || tools[0].Spec().Name != "mcp__old__old" {
		t.Fatalf("tools=%v err=%v", tools, err)
	}
}
