package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type Server struct {
	Tools *tool.Pool
	Env   tool.Env
}

// Serve owns the stream until EOF or cancellation and waits for active tool calls.
func (s *Server) Serve(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer output.Close()
	stop := context.AfterFunc(ctx, func() { _ = input.Close(); _ = output.Close() })
	defer stop()
	var writeMu sync.Mutex
	write := func(value message) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return json.NewEncoder(output).Encode(value)
	}
	var activeMu sync.Mutex
	active := make(map[string]context.CancelFunc)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), messageLimit)
	initialized, ready := false, false
	for scan.Scan() {
		var request message
		if json.Unmarshal(scan.Bytes(), &request) != nil {
			if err := write(message{JSONRPC: "2.0", ID: json.RawMessage(`null`), Error: &rpcError{Code: -32700, Message: "Parse error"}}); err != nil {
				return err
			}
			continue
		}
		if request.Method == "notifications/initialized" && initialized {
			ready = true
			continue
		}
		if request.Method == "notifications/cancelled" {
			var params struct {
				RequestID json.RawMessage `json:"requestId"`
			}
			if json.Unmarshal(request.Params, &params) == nil {
				activeMu.Lock()
				if cancel := active[string(params.RequestID)]; cancel != nil {
					cancel()
				}
				activeMu.Unlock()
			}
			continue
		}
		if len(request.ID) == 0 {
			continue
		}
		response := message{JSONRPC: "2.0", ID: request.ID}
		if request.JSONRPC != "2.0" || request.Method == "" || string(request.ID) == "null" {
			response.Error = &rpcError{Code: -32600, Message: "Invalid request"}
		} else if request.Method == "initialize" && !initialized {
			var params struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ProtocolVersion == "" {
				response.Error = &rpcError{Code: -32602, Message: "Protocol version is required"}
			} else {
				initialized = true
				version := params.ProtocolVersion
				if version != "2024-11-05" && version != "2025-03-26" && version != "2025-06-18" {
					version = Version
				}
				response.Result = body(map[string]any{"protocolVersion": version, "serverInfo": map[string]string{"name": "merakcode", "version": merak.Version()}, "capabilities": map[string]any{"tools": map[string]any{}}})
			}
		} else if request.Method == "ping" {
			response.Result = json.RawMessage(`{}`)
		} else if !ready {
			response.Error = &rpcError{Code: -32000, Message: "Client must initialize first"}
		} else if request.Method == "tools/list" {
			tools := []descriptor{}
			for _, spec := range s.Tools.Specs() {
				schema := spec.Input
				if len(schema) == 0 {
					schema = json.RawMessage(`{"type":"object"}`)
				}
				tools = append(tools, descriptor{Name: spec.Name, Description: spec.Description, Input: schema})
			}
			response.Result = body(map[string]any{"tools": tools})
		} else if request.Method == "tools/call" {
			var params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.Name == "" {
				response.Error = &rpcError{Code: -32602, Message: "Tool name is required"}
			} else if operation, ok := s.Tools.Lookup(params.Name); !ok {
				response.Error = &rpcError{Code: -32602, Message: "Unknown tool"}
			} else {
				callCtx, stopCall := context.WithCancel(ctx)
				key := string(request.ID)
				activeMu.Lock()
				duplicate := active[key] != nil
				if !duplicate {
					active[key] = stopCall
				}
				activeMu.Unlock()
				if duplicate {
					stopCall()
					response.Error = &rpcError{Code: -32600, Message: "Duplicate request ID"}
				} else {
					workers.Go(func() {
						defer stopCall()
						defer func() { activeMu.Lock(); delete(active, key); activeMu.Unlock() }()
						input := params.Arguments
						if len(input) == 0 {
							input = json.RawMessage(`{}`)
						}
						value, err := operation.Run(callCtx, tool.Call{ID: key, Name: params.Name, Input: input, Env: s.Env})
						out := result{Content: []content{}, IsError: value.IsError}
						if err != nil {
							out.IsError = true
							out.Content = append(out.Content, content{Type: "text", Text: err.Error()})
						}
						for _, part := range value.Parts {
							if part.Text != "" {
								out.Content = append(out.Content, content{Type: "text", Text: part.Text})
							}
						}
						if err := write(message{JSONRPC: "2.0", ID: request.ID, Result: body(out)}); err != nil {
							cancel()
						}
					})
					continue
				}
			}
		} else {
			response.Error = &rpcError{Code: -32601, Message: "Method not found"}
		}
		if err := write(response); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err := scan.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
