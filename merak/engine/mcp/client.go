package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"sync"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

var validName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

type Client struct {
	name     string
	input    io.ReadCloser
	output   io.WriteCloser
	scan     *bufio.Scanner
	mu       sync.Mutex
	next     uint64
	pending  map[string]chan message
	writes   chan message
	done     chan struct{}
	once     sync.Once
	closeErr error
}

func Connect(ctx context.Context, name string, input io.ReadCloser, output io.WriteCloser) (*Client, error) {
	if !validName.MatchString(name) {
		return nil, errors.New("invalid MCP server name")
	}
	c := &Client{name: name, input: input, output: output, scan: bufio.NewScanner(input), pending: make(map[string]chan message), writes: make(chan message, 32), done: make(chan struct{})}
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	c.scan.Buffer(make([]byte, 4096), messageLimit)
	go c.read()
	go c.write()
	var initialized struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools *json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	if err := c.call(ctx, "initialize", map[string]any{"protocolVersion": Version, "clientInfo": map[string]string{"name": "merakcode", "version": merak.Version()}, "capabilities": map[string]any{}}, &initialized); err != nil {
		c.Close()
		return nil, err
	}
	if initialized.ProtocolVersion != Version || initialized.Capabilities.Tools == nil {
		c.Close()
		return nil, errors.New("MCP server must negotiate a supported tools protocol")
	}
	if err := c.send(ctx, message{JSONRPC: "2.0", Method: "notifications/initialized"}); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) Close() error {
	c.once.Do(func() {
		close(c.done)
		for _, err := range []error{c.output.Close(), c.input.Close()} {
			if !errors.Is(err, net.ErrClosed) {
				c.closeErr = errors.Join(c.closeErr, err)
			}
		}
	})
	return c.closeErr
}

func (c *Client) call(ctx context.Context, method string, params any, target any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	c.next++
	id := json.RawMessage(strconv.FormatUint(c.next, 10))
	replies := make(chan message, 1)
	c.pending[string(id)] = replies
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, string(id)); c.mu.Unlock() }()
	if err := c.send(ctx, message{JSONRPC: "2.0", ID: id, Method: method, Params: body(params)}); err != nil {
		return err
	}
	select {
	case response := <-replies:
		if response.Error != nil {
			return response.Error
		}
		return json.Unmarshal(response.Result, target)
	case <-ctx.Done():
		select {
		case c.writes <- message{JSONRPC: "2.0", Method: "notifications/cancelled", Params: body(map[string]any{"requestId": id})}:
		default:
		}
		return ctx.Err()
	case <-c.done:
		return io.EOF
	}
}

func (c *Client) send(ctx context.Context, value message) error {
	select {
	case <-c.done:
		return io.EOF
	default:
	}
	select {
	case c.writes <- value:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return io.EOF
	}
}

func (c *Client) write() {
	defer c.Close()
	for {
		select {
		case value := <-c.writes:
			if json.NewEncoder(c.output).Encode(value) != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

func (c *Client) read() {
	defer c.Close()
	for c.scan.Scan() {
		var response message
		if json.Unmarshal(c.scan.Bytes(), &response) != nil || response.JSONRPC != "2.0" {
			return
		}
		if response.Method != "" {
			if len(response.ID) > 0 {
				if err := c.send(context.Background(), message{JSONRPC: "2.0", ID: response.ID, Error: &rpcError{Code: -32601, Message: "Unsupported client capability"}}); err != nil {
					return
				}
			}
			continue
		}
		c.mu.Lock()
		replies := c.pending[string(response.ID)]
		c.mu.Unlock()
		if replies != nil {
			select {
			case replies <- response:
			default:
			}
		}
	}
}

func (c *Client) Tools(ctx context.Context) ([]tool.Tool, error) {
	var tools []tool.Tool
	seen, cursors := map[string]bool{}, map[string]bool{}
	cursor := ""
	for {
		params := map[string]string{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Tools []descriptor `json:"tools"`
			Next  string       `json:"nextCursor"`
		}
		if err := c.call(ctx, "tools/list", params, &page); err != nil {
			return nil, err
		}
		for _, remote := range page.Tools {
			if !validName.MatchString(remote.Name) || seen[remote.Name] {
				return nil, errors.New("invalid or duplicate MCP tool name")
			}
			var schema map[string]json.RawMessage
			if json.Unmarshal(remote.Input, &schema) != nil || schema == nil {
				return nil, errors.New("MCP tool schema must be an object")
			}
			seen[remote.Name] = true
			tools = append(tools, remoteTool{client: c, remote: remote})
		}
		if page.Next == "" {
			return tools, nil
		}
		if cursors[page.Next] {
			return nil, errors.New("MCP server repeated a tools cursor")
		}
		cursors[page.Next], cursor = true, page.Next
	}
}

type remoteTool struct {
	client *Client
	remote descriptor
}

func (t remoteTool) Spec() tool.Spec {
	return tool.Spec{Name: "mcp__" + t.client.name + "__" + t.remote.Name, Description: t.remote.Description, Input: t.remote.Input, Effect: tool.EffectExec}
}

func (t remoteTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	var out result
	if err := t.client.call(ctx, "tools/call", map[string]any{"name": t.remote.Name, "arguments": call.Input}, &out); err != nil {
		return tool.Result{}, err
	}
	value := tool.Result{IsError: out.IsError}
	if out.IsError {
		value.Code = "MRK-5001"
	}
	for _, part := range out.Content {
		if part.Type == "text" {
			value.Parts = append(value.Parts, model.Part{Text: part.Text})
			continue
		}
		value.Parts = append(value.Parts, model.Part{Text: fmt.Sprintf("Unsupported MCP content type: %s", part.Type)})
	}
	if len(out.Structured) > 0 {
		value.Parts = append(value.Parts, model.Part{Text: string(out.Structured)})
	}
	return value, nil
}
