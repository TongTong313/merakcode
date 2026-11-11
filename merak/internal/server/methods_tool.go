package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/TongTong313/merakcode/merak/engine/clienttool"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// owner names a connection to the registry of client tools.
func (c *connection) owner() string { return fmt.Sprintf("%p", c.ws) }

func (s *Server) toolMethods() map[string]handler {
	return map[string]handler{
		"tool.register": run(func(_ context.Context, c *connection, params protocol.ToolRegisterParams) (any, error) {
			definition := clienttool.Definition{Name: params.Name, Description: params.Description, Schema: params.Schema, Effect: tool.Effect(params.Effect)}
			return done(s.engine.RegisterClientTool(c.owner(), definition, c.callTool))
		}),
		"tool.unregister": run(func(_ context.Context, c *connection, params protocol.ToolUnregisterParams) (any, error) {
			s.engine.UnregisterClientTool(c.owner(), params.Name)
			return nil, nil
		}),
		"tool.result": run(func(_ context.Context, c *connection, params protocol.ToolResultParams) (any, error) {
			c.toolMu.Lock()
			reply := c.toolCalls[params.Call]
			delete(c.toolCalls, params.Call)
			c.toolMu.Unlock()
			if reply == nil {
				return nil, errors.New("no tool call is waiting for this result")
			}
			reply <- params
			return nil, nil
		}),
	}
}

// callTool sends one tool call to the client of the connection and waits for its tool.result.
func (c *connection) callTool(ctx context.Context, name string, input json.RawMessage) (string, bool, error) {
	id := string(event.NewID())
	reply := make(chan protocol.ToolResultParams, 1)
	c.toolMu.Lock()
	if c.toolCalls == nil {
		c.toolCalls = make(map[string]chan protocol.ToolResultParams)
	}
	c.toolCalls[id] = reply
	c.toolMu.Unlock()
	defer func() { c.toolMu.Lock(); delete(c.toolCalls, id); c.toolMu.Unlock() }()
	params, err := json.Marshal(protocol.ToolCallParams{Call: id, Name: name, Input: input})
	if err != nil {
		return "", false, err
	}
	body, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "tool.call", Params: params})
	if err := c.ws.Write(body); err != nil {
		return "", false, errors.New("the client that offered this tool is gone")
	}
	select {
	case result := <-reply:
		return result.Text, result.IsError, nil
	case <-c.closed:
		return "", false, errors.New("the client that offered this tool is gone")
	case <-ctx.Done():
		return "", false, ctx.Err()
	}
}
