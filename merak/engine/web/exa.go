// Package web holds the tools that reach the web: fetching a page and searching the web and code.
package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// ExaURL is the public MCP service that answers web and code searches.
const ExaURL = "https://mcp.exa.ai/mcp"

// Service is the search service. It connects for every call: a search is rare and the service keeps no state worth
// holding on to.
type Service struct {
	// URL is the address of the service; empty means ExaURL.
	URL string
}

func (s Service) call(ctx context.Context, name string, arguments map[string]any) (tool.Result, error) {
	address := s.URL
	if address == "" {
		address = ExaURL
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	client, err := mcp.ConnectHTTP(ctx, "search", mcp.HTTPOptions{URL: address})
	if err != nil {
		return tool.Fail(fmt.Errorf("the search service is not reachable: %w", err)), nil
	}
	defer client.Close()
	text, err := client.CallTool(ctx, name, arguments)
	if err != nil {
		if ctx.Err() != nil {
			return tool.Fail(errors.New("the search took too long")), nil
		}
		return tool.Fail(err), nil
	}
	return tool.Result{Parts: []model.Part{{Text: text}}}, nil
}

// queryOf reads the query of a search call and one optional positive number.
func queryOf(input []byte, limitName string, limit *int) (string, error) {
	var query string
	raw := map[string]json.RawMessage{}
	if err := tool.Decode(input, &raw); err != nil {
		return "", err
	}
	if value, ok := raw["query"]; ok {
		if err := json.Unmarshal(value, &query); err != nil {
			return "", errors.New("query must be text")
		}
	}
	if strings.TrimSpace(query) == "" {
		return "", errors.New("query is required")
	}
	if value, ok := raw[limitName]; ok {
		if err := json.Unmarshal(value, limit); err != nil || *limit < 0 {
			return "", errors.New(limitName + " must be a positive number")
		}
	}
	return query, nil
}

// Search searches the web.
type Search struct{ Service }

func (Search) Spec() tool.Spec {
	return tool.Spec{Name: "web_search", Description: "Search the web and return the best results with their text, for facts newer than your knowledge. Needs network permission.", Effect: tool.EffectNetwork,
		Input: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":1},"numResults":{"type":"integer","minimum":1,"maximum":20}},"required":["query"],"additionalProperties":false}`)}
}

func (s Search) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	var results int
	query, err := queryOf(call.Input, "numResults", &results)
	if err != nil {
		return tool.Fail(err), nil
	}
	arguments := map[string]any{"query": query}
	if results > 0 {
		arguments["numResults"] = results
	}
	return s.call(ctx, "web_search_exa", arguments)
}

// Code searches for code examples and documentation.
type Code struct{ Service }

func (Code) Spec() tool.Spec {
	return tool.Spec{Name: "code_search", Description: "Search for code examples, API usage and library docs and return snippets. Needs network permission.", Effect: tool.EffectNetwork,
		Input: json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","minLength":1},"tokensNum":{"type":"integer","minimum":1000,"maximum":50000}},"required":["query"],"additionalProperties":false}`)}
}

func (s Code) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	var tokens int
	query, err := queryOf(call.Input, "tokensNum", &tokens)
	if err != nil {
		return tool.Fail(err), nil
	}
	arguments := map[string]any{"query": query}
	if tokens > 0 {
		arguments["tokensNum"] = tokens
	}
	return s.call(ctx, "get_code_context_exa", arguments)
}
