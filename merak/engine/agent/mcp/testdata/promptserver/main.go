// Command promptserver is a small MCP server with one tool and two prompts, for tests that need real prompts.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Name      string            `json:"name"`
		Arguments map[string]string `json:"arguments"`
	} `json:"params"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	out := json.NewEncoder(os.Stdout)
	reply := func(id json.RawMessage, result any) {
		_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	fail := func(id json.RawMessage, message string) {
		_ = out.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32602, "message": message}})
	}
	for scanner.Scan() {
		var call request
		if json.Unmarshal(scanner.Bytes(), &call) != nil || len(call.ID) == 0 {
			continue
		}
		switch call.Method {
		case "initialize":
			reply(call.ID, map[string]any{"protocolVersion": "2025-11-25", "capabilities": map[string]any{"tools": map[string]any{}, "prompts": map[string]any{}}, "serverInfo": map[string]string{"name": "promptserver"}})
		case "tools/list":
			reply(call.ID, map[string]any{"tools": []map[string]any{{"name": "ping", "inputSchema": map[string]any{"type": "object"}}}})
		case "prompts/list":
			reply(call.ID, map[string]any{"prompts": []map[string]any{
				{"name": "explain", "description": "Explain a topic", "arguments": []map[string]any{{"name": "topic", "required": true}}},
				{"name": "summarize", "description": "Summarize text"},
			}})
		case "prompts/get":
			if call.Params.Name != "explain" && call.Params.Name != "summarize" {
				fail(call.ID, "unknown prompt")
				continue
			}
			text := "Please summarize the text."
			if call.Params.Name == "explain" {
				text = "Please explain " + strings.TrimSpace(call.Params.Arguments["topic"]) + " in simple words."
			}
			reply(call.ID, map[string]any{"messages": []map[string]any{{"role": "user", "content": map[string]string{"type": "text", "text": text}}}})
		default:
			fail(call.ID, "unsupported")
		}
	}
}
