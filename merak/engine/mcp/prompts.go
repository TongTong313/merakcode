package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// PromptArgument is one argument of a prompt a server offers.
type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// Prompt is a prompt template of a server.
type Prompt struct {
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}

// Prompts lists the prompts of the server; a server without prompts has none.
func (c *Client) Prompts(ctx context.Context) ([]Prompt, error) {
	var prompts []Prompt
	cursor, seen := "", map[string]bool{}
	for {
		params := map[string]string{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Prompts []Prompt `json:"prompts"`
			Next    string   `json:"nextCursor"`
		}
		if err := c.call(ctx, "prompts/list", params, &page); err != nil {
			var rpc *rpcError
			if errors.As(err, &rpc) && rpc.Code == -32601 {
				return nil, nil
			}
			return nil, err
		}
		for _, prompt := range page.Prompts {
			if validName.MatchString(prompt.Name) {
				prompts = append(prompts, prompt)
			}
		}
		if page.Next == "" || seen[page.Next] {
			return prompts, nil
		}
		seen[page.Next], cursor = true, page.Next
	}
}

// CallTool calls one tool of the server by its own name and returns the text of its answer.
func (c *Client) CallTool(ctx context.Context, name string, arguments map[string]any) (string, error) {
	var out result
	if err := c.call(ctx, "tools/call", map[string]any{"name": name, "arguments": arguments}, &out); err != nil {
		return "", err
	}
	var parts []string
	for _, item := range out.Content {
		if item.Type == "text" {
			parts = append(parts, item.Text)
		}
	}
	text := strings.Join(parts, "\n")
	if out.IsError {
		return "", errors.New(strings.TrimSpace(text))
	}
	return text, nil
}

// GetPrompt expands a prompt with its arguments and returns its text.
func (c *Client) GetPrompt(ctx context.Context, name string, arguments map[string]string) (string, error) {
	var expanded struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := c.call(ctx, "prompts/get", map[string]any{"name": name, "arguments": arguments}, &expanded); err != nil {
		return "", err
	}
	var parts []string
	for _, message := range expanded.Messages {
		var content struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(message.Content, &content) == nil && content.Type == "text" {
			parts = append(parts, content.Text)
		}
	}
	if len(parts) == 0 {
		return "", errors.New("the prompt has no text")
	}
	return strings.Join(parts, "\n\n"), nil
}
