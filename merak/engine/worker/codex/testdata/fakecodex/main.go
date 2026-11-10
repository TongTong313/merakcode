package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/testmcp"
)

type message struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
	Result struct{ Decision string }
}

func main() {
	var mcpServer worker.MCPConfig
	if os.Getenv("MERAKCODE_FIXTURE_MCP") == "1" {
		mcpServer.Env = map[string]string{}
		for _, arg := range os.Args[1:] {
			key, value, ok := strings.Cut(arg, "=")
			if !ok {
				continue
			}
			switch key {
			case "mcp_servers.merak.command":
				_ = json.Unmarshal([]byte(value), &mcpServer.Command)
			case "mcp_servers.merak.args":
				_ = json.Unmarshal([]byte(value), &mcpServer.Args)
			default:
				if strings.HasPrefix(key, "mcp_servers.merak.env.") {
					var name, text string
					_ = json.Unmarshal([]byte(strings.TrimPrefix(key, "mcp_servers.merak.env.")), &name)
					_ = json.Unmarshal([]byte(value), &text)
					mcpServer.Env[name] = text
				}
			}
		}
		if mcpServer.Command == "" {
			os.Exit(20)
		}
	}
	scan := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	send := func(value any) {
		if enc.Encode(value) != nil {
			os.Exit(2)
		}
	}
	notify := func(method string, params any) { send(map[string]any{"method": method, "params": params}) }
	initialized := false
	history := os.Getenv("MERAKCODE_FIXTURE_MODE") == "history"
	resumed := false
	leader := &testmcp.Leader{Server: mcpServer}
	boundary := os.Getenv("MERAKCODE_FIXTURE_MODE") == "leader-boundary"
	starts := 0
	waitBoundary := func(suffix string) {
		if path := os.Getenv("MERAKCODE_FIXTURE_BOUNDARY_WAIT"); path != "" {
			for {
				if _, err := os.Stat(path + suffix); err == nil {
					return
				}
				time.Sleep(time.Millisecond)
			}
		}
	}
	for scan.Scan() {
		var m message
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			os.Exit(3)
		}
		reply := func(value any) { send(map[string]any{"id": m.ID, "result": value}) }
		if m.Method == "thread/start" || m.Method == "thread/resume" {
			var policy struct{ Sandbox, ApprovalPolicy string }
			_ = json.Unmarshal(m.Params, &policy)
			if want := os.Getenv("MERAKCODE_FIXTURE_SANDBOX"); want != "" && policy.Sandbox != want {
				os.Exit(16)
			}
			if want := os.Getenv("MERAKCODE_FIXTURE_APPROVAL"); want != "" && policy.ApprovalPolicy != want {
				os.Exit(17)
			}
		}
		switch m.Method {
		case "initialize":
			reply(map[string]any{"userAgent": "fixture"})
		case "initialized":
			initialized = true
		case "thread/start":
			if history {
				if _, err := os.Stat("history.txt"); err == nil {
					os.Exit(12)
				}
			}
			var p struct{ Cwd, ApprovalPolicy, Sandbox string }
			_ = json.Unmarshal(m.Params, &p)
			cwd, _ := os.Getwd()
			if os.Getenv("MERAKCODE_FIXTURE_READONLY") == "1" && p.Sandbox != "read-only" {
				os.Exit(9)
			}
			approval := os.Getenv("MERAKCODE_FIXTURE_APPROVAL")
			if approval == "" {
				approval = "untrusted"
			}
			if !initialized || p.Cwd != cwd || p.ApprovalPolicy != approval {
				os.Exit(4)
			}
			reply(map[string]any{"thread": map[string]string{"id": "thread-1"}})
		case "thread/resume":
			var p struct{ ThreadID string }
			_ = json.Unmarshal(m.Params, &p)
			if strings.HasPrefix(os.Getenv("MERAKCODE_FIXTURE_MODE"), "recovery-") {
				if p.ThreadID != "thread-1" {
					os.Exit(33)
				}
				reply(map[string]any{"thread": map[string]string{"id": "thread-1"}})
				continue
			}
			body, err := os.ReadFile("history.txt")
			if err != nil || string(body) != "Original brief" || p.ThreadID != "thread-1" {
				os.Exit(13)
			}
			resumed = true
			reply(map[string]any{"thread": map[string]string{"id": "thread-1"}})
		case "turn/start":
			starts++
			if os.Getenv("MERAKCODE_FIXTURE_MODE") == "recovery-fail" {
				os.Exit(34)
			}
			reply(map[string]any{"turn": map[string]string{"id": "turn-1", "status": "inProgress"}})
			if os.Getenv("MERAKCODE_FIXTURE_MODE") == "budget" {
				notify("thread/tokenUsage/updated", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "tokenUsage": map[string]any{"total": map[string]int{"inputTokens": 20, "outputTokens": 5, "cachedInputTokens": 3}}})
				continue
			}
			if os.Getenv("MERAKCODE_FIXTURE_MODE") == "recovery-echo" {
				var p struct{ Input []struct{ Text string } }
				_ = json.Unmarshal(m.Params, &p)
				if len(p.Input) != 1 {
					os.Exit(35)
				}
				notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "recovered", "type": "agentMessage", "text": p.Input[0].Text}})
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			if boundary {
				if starts == 1 {
					continue
				}
				var p struct{ Input []struct{ Text string } }
				_ = json.Unmarshal(m.Params, &p)
				if len(p.Input) != 1 || p.Input[0].Text != "Second" {
					os.Exit(30)
				}
				notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "second", "type": "agentMessage", "text": "Second"}})
				waitBoundary(".second")
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			if os.Getenv("MERAKCODE_FIXTURE_LEADER") == "1" {
				var p struct{ Input []struct{ Text string } }
				_ = json.Unmarshal(m.Params, &p)
				if len(p.Input) != 1 || leader.Handle(p.Input[0].Text) != nil {
					os.Exit(23)
				}
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			if os.Getenv("MERAKCODE_FIXTURE_MCP") == "1" {
				if err := testmcp.Report(mcpServer); err != nil {
					os.Exit(21)
				}
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			if os.Getenv("MERAKCODE_FIXTURE_MODE") == "interrupted" {
				notify("item/agentMessage/delta", map[string]string{"threadId": "thread-1", "turnId": "turn-1", "itemId": "message-1", "delta": "Partial answer"})
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "interrupted"}})
				continue
			}
			if history {
				var p struct{ Input []struct{ Text string } }
				_ = json.Unmarshal(m.Params, &p)
				if len(p.Input) != 1 {
					os.Exit(14)
				}
				text := "First report"
				if resumed {
					text = "Preserved original context"
				} else {
					if err := os.WriteFile("history.txt", []byte(p.Input[0].Text), 0600); err != nil {
						os.Exit(15)
					}
				}
				notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "message-1", "type": "agentMessage", "text": text}})
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			if os.Getenv("MERAKCODE_FIXTURE_MODE") != "" {
				notify("item/agentMessage/delta", map[string]string{"threadId": "thread-1", "turnId": "turn-1", "itemId": "message-1", "delta": "Waiting"})
				continue
			}
			notify("item/started", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "call-1", "type": "commandExecution", "command": "verify", "cwd": "."}})
			send(map[string]any{"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "call-1", "command": "verify", "cwd": "."}})
		case "turn/steer":
			if boundary {
				waitBoundary("")
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				send(map[string]any{"id": m.ID, "error": map[string]any{"code": -32600, "message": "no active turn to steer"}})
				continue
			}
			var p struct {
				ThreadID, ExpectedTurnID string
				Input                    []struct{ Type, Text string }
			}
			_ = json.Unmarshal(m.Params, &p)
			if p.ThreadID != "thread-1" || p.ExpectedTurnID != "turn-1" || len(p.Input) != 1 {
				os.Exit(8)
			}
			reply(map[string]string{"turnId": "turn-1"})
			if os.Getenv("MERAKCODE_FIXTURE_LEADER") == "1" {
				if leader.Handle(p.Input[0].Text) != nil {
					os.Exit(24)
				}
				notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
				continue
			}
			notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]string{"id": "message-1", "type": "agentMessage", "text": p.Input[0].Text}})
			notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
		case "":
			if string(m.ID) != `"approval-1"` {
				os.Exit(5)
			}
			text, status := "Denied", "declined"
			if m.Result.Decision == "accept" {
				text, status = "Approved", "completed"
			}
			notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "call-1", "type": "commandExecution", "status": status, "aggregatedOutput": text, "exitCode": 0}})
			notify("item/agentMessage/delta", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "itemId": "message-1", "delta": text})
			notify("item/completed", map[string]any{"threadId": "thread-1", "turnId": "turn-1", "item": map[string]any{"id": "message-1", "type": "agentMessage", "text": text}})
			notify("turn/completed", map[string]any{"threadId": "thread-1", "turn": map[string]string{"id": "turn-1", "status": "completed"}})
		default:
			os.Exit(6)
		}
	}
}
