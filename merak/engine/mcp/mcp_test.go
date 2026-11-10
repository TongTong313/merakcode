package mcp_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type cancellableTool struct{ started chan struct{} }

func (c cancellableTool) Spec() tool.Spec {
	return tool.Spec{Name: "wait", Input: json.RawMessage(`{"type":"object"}`), Effect: tool.EffectRead}
}
func (c cancellableTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	if string(call.Input) == `{"wait":true}` {
		close(c.started)
		<-ctx.Done()
		return tool.Result{}, ctx.Err()
	}
	return tool.Result{Parts: []model.Part{{Text: "still connected"}}}, nil
}

func TestCancellingOneMCPCallKeepsTheSessionConnection(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	operation := cancellableTool{started: make(chan struct{})}
	server := mcp.Server{Tools: tool.NewPool("fixture", operation)}
	go func() { _ = server.Serve(ctx, input, output) }()
	client, err := mcp.Connect(ctx, "fixture", reader, writer)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	operations, err := client.Tools(ctx)
	if err != nil {
		t.Fatal(err)
	}
	callCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, err := operations[0].Run(callCtx, tool.Call{Input: json.RawMessage(`{"wait":true}`)})
		done <- err
	}()
	select {
	case <-operation.started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	stop()
	if err := <-done; err == nil {
		t.Fatal("cancelled call succeeded")
	}
	result, err := operations[0].Run(ctx, tool.Call{Input: json.RawMessage(`{}`)})
	if err != nil || result.IsError || result.Parts[0].Text != "still connected" {
		t.Fatalf("next call=%+v %v", result, err)
	}
}

func TestMCPToolsLoadOnDemandAndExecuteAgainstTheServer(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "note.txt"), []byte("MCP fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	serverInput, clientOutput := io.Pipe()
	clientInput, serverOutput := io.Pipe()
	server := mcp.Server{Tools: tool.NewPool("fixture", tool.ReadFile{}), Env: tool.Env{Workdir: directory, Reads: new(tool.Reads)}}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, serverInput, serverOutput) }()
	client, err := mcp.Connect(ctx, "fixture", clientInput, clientOutput)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	deferred, err := client.Tools(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pool := tool.NewPool("worker")
	pool.Deferred = make(map[string]tool.Tool)
	for _, operation := range deferred {
		pool.Deferred[operation.Spec().Name] = operation
	}
	for _, spec := range pool.Specs() {
		if spec.Name == "mcp__fixture__read_file" {
			t.Fatal("MCP schema was eager")
		}
	}
	invoke, ok := pool.Lookup("call_tool")
	if !ok {
		t.Fatal("missing call_tool")
	}
	call := tool.Call{ID: "read", Input: json.RawMessage(`{"name":"mcp__fixture__read_file","input":{"path":"note.txt"}}`)}
	result, err := invoke.Run(ctx, call)
	if err != nil || !result.IsError {
		t.Fatalf("unloaded tool executed: %+v %v", result, err)
	}
	load, ok := pool.Lookup("load_tools")
	if !ok {
		t.Fatal("missing load_tools")
	}
	result, err = load.Run(ctx, tool.Call{Input: json.RawMessage(`{"names":["mcp__fixture__read_file"]}`)})
	if err != nil || result.IsError || !strings.Contains(result.Parts[0].Text, `"path"`) {
		t.Fatalf("schema=%+v err=%v", result, err)
	}
	result, err = invoke.Run(ctx, call)
	if err != nil || result.IsError || !strings.Contains(result.Parts[0].Text, "MCP fixture") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("MCP server did not close")
	}
}

func TestMCPServerCancellationClosesABlockedOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	done := make(chan error, 1)
	server := mcp.Server{Tools: tool.NewPool("empty")}
	go func() { done <- server.Serve(ctx, input, output) }()
	if _, err := io.WriteString(writer, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n"); err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked output prevented shutdown")
	}
}
