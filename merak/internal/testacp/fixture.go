// Package testacp serves a deterministic ACP peer for adapter integration tests.
package testacp

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

type message struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
	Result struct {
		Outcome struct{ Outcome, OptionID string }
	}
}

func Serve(product string) {
	if product == "opencode" {
		if len(os.Args) < 2 || os.Args[1] != "acp" {
			os.Exit(10)
		}
		var config struct{ Permission json.RawMessage }
		if json.Unmarshal([]byte(os.Getenv("OPENCODE_CONFIG_CONTENT")), &config) != nil {
			os.Exit(11)
		}
		if os.Getenv("MERAKCODE_FIXTURE_READONLY") == "1" {
			var rules map[string]string
			if json.Unmarshal(config.Permission, &rules) != nil || rules["*"] != "deny" || rules["read"] != "allow" || rules["bash"] == "allow" {
				os.Exit(12)
			}
		} else if string(config.Permission) != `"ask"` {
			os.Exit(11)
		}
	}
	scan := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	send := func(value any) {
		if enc.Encode(value) != nil {
			os.Exit(2)
		}
	}
	update := func(value any) {
		send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "session-1", "update": value}})
	}
	var prompt json.RawMessage
	history := os.Getenv("MERAKCODE_FIXTURE_MODE") == "history"
	resumed := false
	for scan.Scan() {
		var m message
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			os.Exit(3)
		}
		reply := func(value any) { send(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": value}) }
		switch m.Method {
		case "initialize":
			var p struct{ ProtocolVersion int }
			_ = json.Unmarshal(m.Params, &p)
			if p.ProtocolVersion != 1 {
				os.Exit(4)
			}
			reply(map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}})
		case "session/new":
			if history {
				if _, err := os.Stat("history.txt"); err == nil {
					os.Exit(13)
				}
			}
			var p struct {
				Cwd        string
				MCPServers []any
			}
			_ = json.Unmarshal(m.Params, &p)
			cwd, _ := os.Getwd()
			if p.Cwd != cwd || p.MCPServers == nil {
				os.Exit(5)
			}
			reply(map[string]string{"sessionId": "session-1"})
		case "session/load":
			var p struct{ SessionID string }
			_ = json.Unmarshal(m.Params, &p)
			body, err := os.ReadFile("history.txt")
			if err != nil || !strings.Contains(string(body), "Original brief") || p.SessionID != "session-1" {
				os.Exit(14)
			}
			resumed = true
			reply(map[string]any{})
		case "session/prompt":
			prompt = m.ID
			if history {
				var p struct{ Prompt []struct{ Text string } }
				_ = json.Unmarshal(m.Params, &p)
				if len(p.Prompt) != 1 {
					os.Exit(15)
				}
				text := "First report"
				if resumed {
					text = "Preserved original context"
				} else {
					if err := os.WriteFile("history.txt", []byte(p.Prompt[0].Text), 0600); err != nil {
						os.Exit(16)
					}
				}
				update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": text}})
				reply(map[string]string{"stopReason": "end_turn"})
				continue
			}
			update(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "Verify", "kind": "execute", "status": "pending", "rawInput": map[string]string{"command": "verify"}})
			send(map[string]any{"jsonrpc": "2.0", "id": "approval", "method": "session/request_permission", "params": map[string]any{"sessionId": "session-1", "toolCall": map[string]any{"toolCallId": "call-1", "title": "Verify", "kind": "execute", "rawInput": map[string]string{"command": "verify"}}, "options": []map[string]string{{"optionId": "yes", "kind": "allow_once", "name": "Allow once"}, {"optionId": "no", "kind": "reject_once", "name": "Reject once"}}}})
		case "":
			if string(m.ID) != `"approval"` {
				os.Exit(6)
			}
			text, status := "Denied", "failed"
			if m.Result.Outcome.Outcome == "selected" && m.Result.Outcome.OptionID == "yes" {
				text, status = "Approved", "completed"
			}
			update(map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": status, "content": []any{map[string]any{"type": "content", "content": map[string]string{"type": "text", "text": text}}}})
			update(map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": text}})
			send(map[string]any{"jsonrpc": "2.0", "id": prompt, "result": map[string]string{"stopReason": "end_turn"}})
		default:
			os.Exit(7)
		}
	}
}
