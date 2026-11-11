package web_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/web"
)

// exaServer is a Streamable HTTP MCP server with the two tools of the public search service.
type exaServer struct {
	mu    sync.Mutex
	calls []struct{ Name, Arguments string }
}

func (s *exaServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var call struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"params"`
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
		reply(map[string]any{"tools": []map[string]any{
			{"name": "web_search_exa", "description": "Search the web", "inputSchema": map[string]any{"type": "object"}},
			{"name": "get_code_context_exa", "description": "Find code", "inputSchema": map[string]any{"type": "object"}},
		}})
	case "tools/call":
		s.mu.Lock()
		s.calls = append(s.calls, struct{ Name, Arguments string }{call.Params.Name, string(call.Params.Arguments)})
		s.mu.Unlock()
		reply(map[string]any{"content": []map[string]string{{"type": "text", "text": "result of " + call.Params.Name}}})
	default:
		w.WriteHeader(http.StatusAccepted)
	}
}

func TestWebSearchAndCodeSearchCallTheSearchServiceThroughTheRemoteMCPClient(t *testing.T) {
	server := &exaServer{}
	host := httptest.NewServer(server)
	defer host.Close()
	service := web.Service{URL: host.URL}
	webSearch := web.Search{Service: service}
	codeSearch := web.Code{Service: service}

	result, err := webSearch.Run(context.Background(), tool.Call{Input: json.RawMessage(`{"query":"go generics tutorial","numResults":3}`)})
	if err != nil || result.IsError || text(result) != "result of web_search_exa" {
		t.Fatalf("web search: %+v err=%v", result, err)
	}
	result, err = codeSearch.Run(context.Background(), tool.Call{Input: json.RawMessage(`{"query":"how to use context.WithCancel","tokensNum":3000}`)})
	if err != nil || result.IsError || text(result) != "result of get_code_context_exa" {
		t.Fatalf("code search: %+v err=%v", result, err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.calls) != 2 || !strings.Contains(server.calls[0].Arguments, "go generics tutorial") || !strings.Contains(server.calls[0].Arguments, `"numResults":3`) || !strings.Contains(server.calls[1].Arguments, "context.WithCancel") {
		t.Fatalf("calls=%+v", server.calls)
	}
	for _, bad := range []string{`{}`, `{"query":""}`, `{"query":"x","numResults":-1}`} {
		if r, _ := webSearch.Run(context.Background(), tool.Call{Input: json.RawMessage(bad)}); !r.IsError {
			t.Errorf("%s was accepted", bad)
		}
	}
	if webSearch.Spec().Effect != tool.EffectNetwork || codeSearch.Spec().Effect != tool.EffectNetwork {
		t.Error("searching asks for network permission")
	}
	down := web.Search{Service: web.Service{URL: "http://127.0.0.1:1/mcp"}}
	if r, err := down.Run(context.Background(), tool.Call{Input: json.RawMessage(`{"query":"x"}`)}); err != nil || !r.IsError {
		t.Errorf("an unreachable service must come back as a tool error: %+v %v", r, err)
	}
}
