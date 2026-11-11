// Package anthropic adapts the official SDK to the engine's model interface.
package anthropic

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	sdk "github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

type Options struct {
	Headers                map[string]string
	Auth                   string
	BaseURL, APIKey, Model string
	Config                 Config
	Catalog                *catalog.Catalog
}

type Client struct {
	client  sdk.Client
	model   string
	config  Config
	catalog *catalog.Catalog
}

func New(o Options) *Client {
	if o.Catalog == nil {
		o.Catalog = catalog.New()
	}
	if o.Config.Name == "" {
		o.Config, _ = Builtin("anthropic")
	}
	if o.BaseURL == "" {
		o.BaseURL = o.Config.BaseURL
	}
	opts := []option.RequestOption{option.WithAPIKey(o.APIKey), option.WithMaxRetries(0), option.WithHTTPClient(&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})}
	if o.Auth == "bearer" {
		opts = append(opts, option.WithAPIKey(""), option.WithAuthToken(o.APIKey))
	} else if o.Config.Name != "anthropic" && o.APIKey != "" {
		opts = append(opts, option.WithHeader("x-api-key", o.APIKey))
	}
	for name, value := range o.Headers {
		opts = append(opts, option.WithHeader(name, value))
	}
	if o.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(o.BaseURL))
	}
	return &Client{client: sdk.NewClient(opts...), model: o.Model, config: o.Config, catalog: o.Catalog}
}

func (c *Client) Name() string { return c.config.Name }

func (c *Client) reasoningProvider() string {
	if c.config.Name == "anthropic" {
		return "anthropic"
	}
	return c.config.Name + "-anthropic"
}

func (c *Client) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	if req.Model == "" {
		req.Model = c.model
	}
	req.Thinking = c.catalog.Get(c.config.Name, req.Model).Clamp(req.Thinking)
	params := sdk.MessageNewParams{Model: sdk.Model(req.Model), MaxTokens: 4096}
	if req.MaxTokens > 0 {
		params.MaxTokens = int64(req.MaxTokens)
	}
	cache := sdk.CacheControlEphemeralParam{Type: "ephemeral", TTL: "5m"}
	if req.Cache.TTL == "1h" {
		cache.TTL = "1h"
	}
	params.CacheControl = cache
	if req.System != "" {
		params.System = []sdk.TextBlockParam{{Text: req.System, CacheControl: cache}}
	}
	for _, spec := range req.Tools {
		var input sdk.ToolInputSchemaParam
		if err := json.Unmarshal(spec.Input, &input); err != nil {
			return nil, providerError(err)
		}
		params.Tools = append(params.Tools, sdk.ToolUnionParam{OfTool: &sdk.ToolParam{Name: spec.Name, Description: sdk.String(spec.Description), InputSchema: input}})
	}
	if c.config.Name == "anthropic" {
		applyThinking(&params, req)
	} else if req.Thinking != "" {
		effort := req.Thinking
		if effort == model.ThinkingOff {
			params.Thinking = sdk.ThinkingConfigParamUnion{OfDisabled: &sdk.ThinkingConfigDisabledParam{}}
		} else {
			params.Thinking = sdk.ThinkingConfigParamOfEnabled(1024)
			params.OutputConfig.Effort = sdk.OutputConfigEffort(effort)
		}
	}
	// The API refuses sampling parameters while the model thinks, so they are sent only without thinking. This SDK
	// has no fields for them, so they travel as extra fields of the request body.
	if sampling := samplingFields(req); len(sampling) > 0 && params.Thinking.OfEnabled == nil && params.Thinking.OfAdaptive == nil {
		params.SetExtraFields(sampling)
	}
	for _, message := range req.Messages {
		var blocks []sdk.ContentBlockParamUnion
		for _, part := range message.Parts {
			switch {
			case part.ToolResult != nil:
				result := part.ToolResult
				wire := sdk.ToolResultBlockParam{ToolUseID: result.CallID, IsError: sdk.Bool(result.IsError)}
				for _, content := range result.Parts {
					block, err := contentBlock(content)
					if err != nil {
						return nil, providerError(err)
					}
					wire.Content = append(wire.Content, sdk.ToolResultBlockParamContentUnion{OfText: block.OfText, OfImage: block.OfImage, OfDocument: block.OfDocument})
				}
				blocks = append(blocks, sdk.ContentBlockParamUnion{OfToolResult: &wire})
			case part.Reasoning != nil:
				if part.Reasoning.Provider != c.reasoningProvider() {
					continue
				}
				var redacted struct {
					Type string `json:"type"`
					Data string `json:"data"`
				}
				if json.Unmarshal(part.Reasoning.Opaque, &redacted) == nil && redacted.Type == "redacted_thinking" {
					blocks = append(blocks, sdk.NewRedactedThinkingBlock(redacted.Data))
					continue
				}
				var signature string
				if err := json.Unmarshal(part.Reasoning.Opaque, &signature); err != nil {
					return nil, providerError(err)
				}
				blocks = append(blocks, sdk.NewThinkingBlock(signature, part.Reasoning.Text))
			case part.ToolCall != nil:
				call := part.ToolCall
				blocks = append(blocks, sdk.NewToolUseBlock(call.ID, call.Input, call.Name))
			case part.Text != "" || part.Image != nil || part.Document != nil:
				block, err := contentBlock(part)
				if err != nil {
					return nil, providerError(err)
				}
				blocks = append(blocks, block)
			}
		}
		if len(blocks) == 0 {
			continue
		}
		if message.Role == model.Assistant {
			params.Messages = append(params.Messages, sdk.NewAssistantMessage(blocks...))
			continue
		}
		params.Messages = append(params.Messages, sdk.NewUserMessage(blocks...))
	}
	raw := c.client.Messages.NewStreaming(ctx, params)
	if err := raw.Err(); err != nil {
		raw.Close()
		return nil, providerError(err)
	}
	return &stream{raw: raw, blocks: make(map[int64]*block), provider: c.reasoningProvider()}, nil
}

func providerError(err error) error {
	failure := &model.Error{Code: "MRK-2001", Cause: err}
	var api *sdk.Error
	if errors.As(err, &api) {
		failure.Status = api.StatusCode
	}
	return failure
}

func samplingFields(req model.Request) map[string]any {
	fields := map[string]any{}
	if req.Temperature != nil {
		fields["temperature"] = *req.Temperature
	}
	if req.TopP != nil {
		fields["top_p"] = *req.TopP
	}
	if req.TopK != nil {
		fields["top_k"] = *req.TopK
	}
	return fields
}
