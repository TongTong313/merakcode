// Package openai implements the Chat Completions streaming protocol using net/http.
package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
)

type Options struct {
	Headers    map[string]string
	Auth       string
	BaseURL    string
	APIKey     string
	Model      string
	Config     Config
	Parameters map[string]json.RawMessage
	Catalog    *catalog.Catalog
}

type Config struct {
	Name           string
	BaseURL        string
	ReasoningField string
	SendReasoning  bool
	NativePDF      bool
	thinking       string
}

type Client struct {
	headers    map[string]string
	auth       string
	baseURL    string
	key        string
	model      string
	http       *http.Client
	config     Config
	parameters map[string]json.RawMessage
	catalog    *catalog.Catalog
}

func New(o Options) *Client {
	if o.Catalog == nil {
		o.Catalog = catalog.New()
	}
	if o.Config.Name == "" {
		o.Config, _ = Builtin("openai")
	}
	if o.Config.ReasoningField == "" {
		o.Config.ReasoningField = "reasoning_content"
	}
	if o.Config.Name == "openai" && o.Config.thinking == "" {
		o.Config.thinking = "effort"
	}
	if o.BaseURL == "" {
		o.BaseURL = o.Config.BaseURL
		if o.BaseURL == "" {
			o.BaseURL = "https://api.openai.com/v1"
		}
	}
	parameters := make(map[string]json.RawMessage)
	for key, value := range o.Parameters {
		parameters[key] = append(json.RawMessage(nil), value...)
	}
	return &Client{headers: maps.Clone(o.Headers), auth: o.Auth, baseURL: strings.TrimRight(o.BaseURL, "/"), key: o.APIKey, model: o.Model, config: o.Config, catalog: o.Catalog, parameters: parameters, http: &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (c *Client) Name() string { return c.config.Name }

func (c *Client) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	if req.Model == "" {
		req.Model = c.model
	}
	req.Thinking = c.catalog.Get(c.config.Name, req.Model).Clamp(req.Thinking)
	req, dropped := prepareDocuments(ctx, req, c.config.NativePDF)
	encoded := encode(req, c.config)
	for key, value := range c.parameters {
		switch key {
		case "model", "messages", "tools", "stream", "stream_options", "max_tokens", "max_completion_tokens":
			continue
		}
		encoded[key] = value
	}
	body, err := json.Marshal(encoded)
	if err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if c.key != "" {
		if c.auth == "x-api-key" {
			request.Header.Set("x-api-key", c.key)
		} else {
			request.Header.Set("Authorization", "Bearer "+c.key)
		}
	}
	for name, value := range c.headers {
		request.Header.Set(name, value)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, &model.Error{Code: "MRK-2001", Status: response.StatusCode}
	}
	stream := newStream(response.Body, c.config)
	stream.pending = dropped
	return stream, nil
}
