package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestACPMCPFixtureProcess(t *testing.T) {
	if os.Getenv("MERAKCODE_CLI_MCP") != "1" {
		return
	}
	endpoint := mcp.Server{Tools: tool.NewPool("fixture", tool.ReadFile{}), Env: tool.Env{Workdir: ".", Reads: new(tool.Reads)}}
	_ = endpoint.Serve(context.Background(), os.Stdin, os.Stdout)
	os.Exit(0)
}

func TestACPServesBuiltinWorkerWithApprovalAndCancellation(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	binary, _ := os.Executable()
	definition := config.MCPServer{Command: binary, Args: []string{"-test.run=^TestACPMCPFixtureProcess$"}, Env: map[string]string{"MERAKCODE_CLI_MCP": "1"}}
	body := config.MCPFile(map[string]config.MCPServer{"docs": definition})
	if err := os.WriteFile(filepath.Join(home, "merakcode.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "source.txt"), []byte("Verified MCP source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "merakcode.json"), []byte(`{"mcp":{"workspace":{"type":"local","command":["missing-workspace-server"]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MERAKCODE_HOME", home)
	var host *server.Instance
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "load", Name: "load_tools", Input: json.RawMessage(`{"names":["mcp__editor__read_file","mcp__docs__read_file"]}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "editor", Name: "call_tool", Input: json.RawMessage(`{"name":"mcp__editor__read_file","input":{"path":"source.txt"}}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "docs", Name: "call_tool", Input: json.RawMessage(`{"name":"mcp__docs__read_file","input":{"path":"source.txt"}}`)}}},
		fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: json.RawMessage(`{"path":"result.txt","content":"Approved"}`)}}},
		fake.Reply{Text: "Completed sk", Expect: func(req model.Request) error {
			body, _ := json.Marshal(req.Messages)
			if strings.Count(string(body), "Verified MCP source") < 2 {
				return fmt.Errorf("client or user MCP tool did not run")
			}
			return nil
		}},
		fake.Reply{Text: "Waiting", Hold: make(chan struct{})},
	)
	e, err := engine.New(engine.Deps{Workdir: project, NetworkSettings: settings, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) { return host.Ask(ctx, req) }})
	if err != nil {
		t.Fatal(err)
	}
	host, err = startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	done := make(chan int, 1)
	go func() {
		done <- Run([]string{"acp", "--provider", "fixture", "--model", "fixture"}, input, output)
		output.Close()
	}()
	encode, decode := json.NewEncoder(writer), json.NewDecoder(reader)
	send := func(id int, method string, params any) {
		t.Helper()
		if err := encode.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
	}
	receive := func() protocol.Message {
		t.Helper()
		result := make(chan protocol.Message, 1)
		go func() { var message protocol.Message; _ = decode.Decode(&message); result <- message }()
		select {
		case message := <-result:
			if message.JSONRPC != "2.0" {
				t.Fatalf("invalid ACP message: %+v", message)
			}
			return message
		case <-time.After(5 * time.Second):
			t.Fatal("ACP response timed out")
			return protocol.Message{}
		}
	}
	send(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{}})
	if message := receive(); message.Error != nil {
		t.Fatal(message.Error)
	}
	for i, transport := range []string{"http", "sse"} {
		send(100+i, "session/new", map[string]any{"cwd": project, "mcpServers": []any{map[string]any{"name": "remote", "type": transport, "url": "https://example.invalid"}}})
		if response := receive(); response.Error == nil || response.Error.Code != -32602 {
			t.Fatalf("unsupported MCP=%+v", response)
		}
	}
	send(2, "session/new", map[string]any{"cwd": project, "mcpServers": []any{
		map[string]any{"name": "editor", "command": binary, "args": definition.Args, "env": []map[string]string{{"name": "MERAKCODE_CLI_MCP", "value": "1"}}},
		map[string]any{"name": "docs", "command": "missing-client-server", "args": []string{}, "env": []any{}},
	}})
	var created struct{ SessionID string }
	if message := receive(); json.Unmarshal(message.Result, &created) != nil || created.SessionID == "" {
		t.Fatalf("session=%s", message.Result)
	}
	send(3, "session/prompt", map[string]any{"sessionId": created.SessionID, "prompt": []map[string]string{{"type": "text", "text": "Write result"}}})
	approved, finished := false, false
	var answer strings.Builder
	for !finished {
		message := receive()
		if message.Method == "session/update" {
			var params struct {
				Update struct {
					SessionUpdate string
					Content       json.RawMessage
				}
			}
			if err := json.Unmarshal(message.Params, &params); err != nil {
				t.Fatal(err)
			}
			if params.Update.SessionUpdate == "agent_message_chunk" {
				var content struct{ Text string }
				if err := json.Unmarshal(params.Update.Content, &content); err != nil {
					t.Fatal(err)
				}
				answer.WriteString(content.Text)
			}
		}
		if message.Method == "session/request_permission" {
			approved = true
			if err := encode.Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": "allow-once"}}}); err != nil {
				t.Fatal(err)
			}
		}
		if string(message.ID) == "3" {
			finished = true
			if message.Error != nil {
				t.Fatal(message.Error)
			}
		}
	}
	if answer.String() != "Completed sk" {
		t.Fatalf("ACP answer=%q", answer.String())
	}
	if body, err := os.ReadFile(filepath.Join(project, "result.txt")); !approved || err != nil || string(body) != "Approved" {
		t.Fatalf("approved=%v result=%q %v", approved, body, err)
	}
	saved, err := config.Open(home)
	if err != nil || len(saved.Private().WorkspaceTrust) != 1 {
		t.Fatal("workspace confirmation did not reach the ACP client")
	}
	send(4, "session/prompt", map[string]any{"sessionId": created.SessionID, "prompt": []map[string]string{{"type": "text", "text": "Wait"}}})
	send(5, "session/cancel", map[string]string{"sessionId": created.SessionID})
	for {
		message := receive()
		if string(message.ID) == "4" {
			var stopped struct{ StopReason string }
			if json.Unmarshal(message.Result, &stopped) != nil || stopped.StopReason != "cancelled" {
				t.Fatalf("cancel=%+v", message)
			}
			break
		}
	}
	writer.Close()
	if code := <-done; code != 0 {
		t.Fatalf("exit=%d", code)
	}
}
