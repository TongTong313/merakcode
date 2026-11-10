package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func runACP(args []string, input io.Reader, output io.Writer) int {
	flags := flag.NewFlagSet("acp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	provider, name := flags.String("provider", "", ""), flags.String("model", "", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	client, err := ensureEngine(ctx, home, *provider, "")
	if err != nil {
		return 1
	}
	defer client.Close()
	if client.Call(ctx, "events.subscribe", event.Filter{}, nil) != nil {
		return 1
	}
	requests := make(chan protocol.Message, 16)
	go func() {
		defer close(requests)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 4<<20)
		for scanner.Scan() {
			var request protocol.Message
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				request = protocol.Message{}
			}
			select {
			case requests <- request:
			case <-ctx.Done():
				return
			}
		}
	}()
	encoder := json.NewEncoder(output)
	send := func(value any) bool { return encoder.Encode(value) == nil }
	reply := func(id json.RawMessage, result any) bool {
		if len(id) == 0 {
			return true
		}
		return send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	fail := func(id json.RawMessage, code int, message string) bool {
		if len(id) == 0 {
			id = json.RawMessage(`null`)
		}
		return send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}})
	}
	update := func(id event.ID, value any) bool {
		return send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": id, "update": value}})
	}
	sessions := map[event.ID]bool{}
	prompts := map[event.ID]json.RawMessage{}
	approvals := map[string]event.ID{}
	defer func() {
		ending, stop := context.WithTimeout(context.Background(), 2*time.Second)
		defer stop()
		for id := range prompts {
			_ = client.Call(ending, "session.cancel", protocol.SessionCancelParams{Session: id}, nil)
		}
	}()
	ready := false
	ui := &renderer{language: defaultLanguage()}
	for {
		select {
		case <-ctx.Done():
			return 0
		case request, ok := <-requests:
			if !ok {
				return 0
			}
			if request.JSONRPC != "2.0" {
				if !fail(request.ID, -32600, "Invalid request") {
					return 1
				}
				continue
			}
			if request.Method == "" {
				id := approvals[string(request.ID)]
				if id == "" {
					continue
				}
				delete(approvals, string(request.ID))
				var result struct {
					Outcome struct{ Outcome, OptionID string }
				}
				decision := permission.Deny
				if request.Error == nil && json.Unmarshal(request.Result, &result) == nil && result.Outcome.Outcome == "selected" && result.Outcome.OptionID == "allow-once" {
					decision = permission.Allow
				}
				_ = client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: id, Decision: decision}, nil)
				continue
			}
			if request.Method == "initialize" {
				var params struct{ ProtocolVersion int }
				if ready || json.Unmarshal(request.Params, &params) != nil || params.ProtocolVersion <= 0 {
					if !fail(request.ID, -32602, "Invalid initialization") {
						return 1
					}
					continue
				}
				ready = true
				if !reply(request.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": false, "mcpCapabilities": map[string]bool{"http": false, "sse": false}, "promptCapabilities": map[string]any{"embeddedContext": true}}, "agentInfo": map[string]string{"name": "merakcode", "version": merak.Version()}, "authMethods": []any{}}) {
					return 1
				}
				continue
			}
			if !ready {
				if !fail(request.ID, -32600, "Initialize first") {
					return 1
				}
				continue
			}
			switch request.Method {
			case "session/new":
				var params struct {
					Cwd        string
					MCPServers []json.RawMessage
				}
				valid := json.Unmarshal(request.Params, &params) == nil && filepath.IsAbs(params.Cwd)
				servers, parseErr := acpMCPServers(params.MCPServers)
				if !valid || parseErr != nil {
					if !fail(request.ID, -32602, "An absolute cwd and valid stdio MCP servers are required") {
						return 1
					}
					continue
				}
				var created protocol.SessionCreateResult
				if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: *provider, Model: *name, Workdir: params.Cwd, MCPServers: servers}, &created); err != nil {
					if !fail(request.ID, -32603, err.Error()) {
						return 1
					}
					continue
				}
				sessions[created.Session] = true
				if !reply(request.ID, map[string]any{"sessionId": created.Session}) {
					return 1
				}
			case "session/prompt", "session/cancel":
				var params struct {
					SessionID event.ID
					Prompt    []struct {
						Type, Text, URI string
						Resource        struct{ URI, Text string }
					}
				}
				if json.Unmarshal(request.Params, &params) != nil || !sessions[params.SessionID] {
					if !fail(request.ID, -32602, "Unknown session") {
						return 1
					}
					continue
				}
				if request.Method == "session/cancel" {
					_ = client.Call(ctx, "session.cancel", protocol.SessionCancelParams{Session: params.SessionID}, nil)
					if !reply(request.ID, struct{}{}) {
						return 1
					}
					continue
				}
				if len(prompts[params.SessionID]) > 0 || len(params.Prompt) == 0 || len(request.ID) == 0 {
					if !fail(request.ID, -32602, "Prompt is empty or session is busy") {
						return 1
					}
					continue
				}
				parts := []model.Part{}
				valid := true
				for _, content := range params.Prompt {
					switch content.Type {
					case "text":
						parts = append(parts, model.Part{Text: content.Text})
					case "resource_link":
						parts = append(parts, model.Part{Text: content.URI})
					case "resource":
						parts = append(parts, model.Part{Text: content.Resource.URI + "\n" + content.Resource.Text})
					default:
						valid = false
					}
				}
				if !valid {
					if !fail(request.ID, -32602, "Unsupported content type") {
						return 1
					}
					continue
				}
				if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: params.SessionID, Parts: parts}, nil); err != nil {
					if !fail(request.ID, -32603, err.Error()) {
						return 1
					}
					continue
				}
				prompts[params.SessionID] = request.ID
			default:
				if len(request.ID) > 0 && !fail(request.ID, -32601, "Method not found") {
					return 1
				}
			}
		case fact, ok := <-client.Events:
			if !ok || fact.Type == event.Lagged {
				return 1
			}
			id := fact.Scope.Session
			if !sessions[id] {
				continue
			}
			switch fact.Type {
			case session.MessageDelta:
				chunk, err := event.Decode[model.Chunk](fact)
				if err != nil {
					return 1
				}
				kind, text := "agent_message_chunk", chunk.Text
				if chunk.Kind == model.ReasoningChunk && chunk.Reasoning != nil {
					kind, text = "agent_thought_chunk", chunk.Reasoning.Text
				} else if chunk.Kind != model.Text {
					continue
				}
				if !update(id, map[string]any{"sessionUpdate": kind, "content": map[string]string{"type": "text", "text": text}}) {
					return 1
				}
			case tool.Called:
				call, err := event.Decode[model.ToolCall](fact)
				if err != nil {
					return 1
				}
				if !update(id, map[string]any{"sessionUpdate": "tool_call", "toolCallId": call.ID, "title": call.Name, "name": call.Name, "kind": "other", "status": "in_progress", "rawInput": call.Input}) {
					return 1
				}
			case tool.Completed:
				result, err := event.Decode[tool.Completion](fact)
				if err != nil {
					return 1
				}
				status := "completed"
				if result.IsError {
					status = "failed"
				}
				content := []any{}
				for _, part := range result.Parts {
					if part.Text != "" {
						content = append(content, map[string]any{"type": "content", "content": map[string]string{"type": "text", "text": part.Text}})
					}
				}
				if !update(id, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": result.CallID, "status": status, "content": content}) {
					return 1
				}
			case permission.Requested:
				req, err := event.Decode[permission.Request](fact)
				if err != nil {
					return 1
				}
				requestID := fmt.Sprintf("permission-%s", fact.ID)
				key, _ := json.Marshal(requestID)
				approvals[string(key)] = fact.ID
				if !send(map[string]any{"jsonrpc": "2.0", "id": requestID, "method": "session/request_permission", "params": map[string]any{"sessionId": id, "toolCall": map[string]any{"toolCallId": req.Call.ID, "title": req.Call.Name, "status": "pending", "rawInput": req.Call.Input}, "options": []map[string]string{{"optionId": "allow-once", "kind": "allow_once", "name": ui.text("allowOnce")}, {"optionId": "reject-once", "kind": "reject_once", "name": ui.text("rejectOnce")}}}}) {
					return 1
				}
			case question.Asked:
				// No elicitation capability was negotiated; do not leave the engine waiting.
				_ = client.Call(ctx, "question.reply", protocol.QuestionReplyParams{Request: fact.ID, Cancelled: true}, nil)
			case loop.TurnFinished:
				outcome, err := event.Decode[loop.Outcome](fact)
				if err != nil {
					return 1
				}
				prompt := prompts[id]
				delete(prompts, id)
				if len(prompt) == 0 {
					continue
				}
				reason := "end_turn"
				if outcome.Stop == loop.Cancelled {
					reason = "cancelled"
				} else if loop.BudgetStop(outcome.Stop) {
					reason = "max_turn_requests"
				} else if outcome.Stop != loop.Answered {
					if !fail(prompt, -32603, outcome.Code) {
						return 1
					}
					continue
				}
				if !reply(prompt, map[string]string{"stopReason": reason}) {
					return 1
				}
			}
		}
	}
}
