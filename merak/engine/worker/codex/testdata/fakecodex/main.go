package main

import (
	"bufio"
	"encoding/json"
	"os"
)

type message struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
	Result struct{ Decision string }
}

func main() {
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
	for scan.Scan() {
		var m message
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			os.Exit(3)
		}
		reply := func(value any) { send(map[string]any{"id": m.ID, "result": value}) }
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
			if !initialized || p.Cwd != cwd || p.ApprovalPolicy != "untrusted" {
				os.Exit(4)
			}
			reply(map[string]any{"thread": map[string]string{"id": "thread-1"}})
		case "thread/resume":
			var p struct{ ThreadID string }
			_ = json.Unmarshal(m.Params, &p)
			body, err := os.ReadFile("history.txt")
			if err != nil || string(body) != "Original brief" || p.ThreadID != "thread-1" {
				os.Exit(13)
			}
			resumed = true
			reply(map[string]any{"thread": map[string]string{"id": "thread-1"}})
		case "turn/start":
			reply(map[string]any{"turn": map[string]string{"id": "turn-1", "status": "inProgress"}})
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
			var p struct {
				ThreadID, ExpectedTurnID string
				Input                    []struct{ Type, Text string }
			}
			_ = json.Unmarshal(m.Params, &p)
			if p.ThreadID != "thread-1" || p.ExpectedTurnID != "turn-1" || len(p.Input) != 1 {
				os.Exit(8)
			}
			reply(map[string]string{"turnId": "turn-1"})
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
