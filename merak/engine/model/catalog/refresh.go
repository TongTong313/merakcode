package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Source struct {
	Provider, BaseURL, APIKey, Protocol, Auth string
	Headers                                   map[string]string
	Disabled                                  bool
}
type Options struct {
	Sources   []Source
	Overrides []Override
}

// Override distinguishes an omitted field from an explicit zero or empty value.
type Override struct {
	Provider  string            `json:"provider"`
	ID        string            `json:"id"`
	Window    *int              `json:"window,omitempty"`
	MaxOutput *int              `json:"maxOutput,omitempty"`
	Price     *Price            `json:"price,omitempty"`
	Caps      *Caps             `json:"caps,omitempty"`
	Thinking  *[]model.Thinking `json:"thinking,omitempty"`
}

func (o Override) copy() Override {
	data, _ := json.Marshal(o)
	var result Override
	_ = json.Unmarshal(data, &result)
	return result
}

func (o Override) apply(m Model, source string) Model {
	set := func(name string) { m.Unknown = slices.DeleteFunc(m.Unknown, func(v string) bool { return v == name }) }
	if o.Window != nil && *o.Window > 0 {
		m.Window = *o.Window
		set("window")
	}
	if o.MaxOutput != nil && *o.MaxOutput > 0 {
		m.MaxOutput = *o.MaxOutput
		set("maxOutput")
	}
	if o.Price != nil {
		m.Price = *o.Price
		m.Price.Tiers = slices.Clone(o.Price.Tiers)
		set("price")
	}
	if o.Caps != nil {
		m.Caps = *o.Caps
		set("caps")
	}
	if o.Thinking != nil {
		m.Thinking = slices.Clone(*o.Thinking)
		set("thinking")
	}
	m.Source = source
	return m
}

// Refresh retains the previous data for any source whose complete fetch fails.
func (c *Catalog) Refresh(ctx context.Context) error {
	return c.RefreshProvider(ctx, "")
}

func (c *Catalog) ConfigureSources(sources []Source) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configuredSources = slices.Clone(sources)
	for index := range c.configuredSources {
		c.configuredSources[index].Headers = maps.Clone(sources[index].Headers)
	}
}

func (c *Catalog) RefreshProvider(ctx context.Context, provider string) error {
	c.mu.RLock()
	sources := slices.Clone(c.sources)
	for _, source := range c.configuredSources {
		sources = slices.DeleteFunc(sources, func(previous Source) bool { return previous.Provider == source.Provider })
		sources = append(sources, source)
	}
	c.mu.RUnlock()
	var failures []error
	for _, source := range sources {
		if source.Disabled || provider != "" && source.Provider != provider {
			continue
		}
		updates, err := fetchModels(ctx, source)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		c.mu.Lock()
		for _, update := range updates {
			m := update.apply(c.get(update.Provider, update.ID), "live")
			index := slices.IndexFunc(c.models, func(v Model) bool { return v.Provider == m.Provider && v.ID == m.ID })
			if index >= 0 {
				c.models[index] = m
			} else {
				c.models = append(c.models, m)
			}
		}
		c.mu.Unlock()
	}
	return errors.Join(failures...)
}

func fetchModels(ctx context.Context, source Source) ([]Override, error) {
	if source.Provider != "anthropic" && source.Provider != "openrouter" && source.Protocol != "openai" && source.Protocol != "anthropic" {
		return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("unsupported catalog source")}
	}
	base := source.BaseURL
	if base == "" {
		base = map[string]string{"anthropic": "https://api.anthropic.com", "openrouter": "https://openrouter.ai/api/v1"}[source.Provider]
	}
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var result []Override
	cursor := ""
	seen := make(map[string]bool)
	for {
		endpoint := strings.TrimRight(base, "/") + "/v1/models"
		if source.Provider == "openrouter" || source.Protocol == "openai" || strings.HasSuffix(strings.TrimRight(base, "/"), "/v1") {
			endpoint = strings.TrimRight(base, "/") + "/models"
		}
		if source.Provider == "anthropic" || source.Protocol == "anthropic" {
			query := url.Values{"limit": {"1000"}}
			if cursor != "" {
				query.Set("after_id", cursor)
			}
			endpoint += "?" + query.Encode()
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, &model.Error{Code: "MRK-2001", Cause: err}
		}
		request.Header.Set("anthropic-version", "2026-10-21")
		if source.APIKey != "" {
			if source.Auth == "x-api-key" || source.Auth == "" && source.Protocol == "anthropic" {
				request.Header.Set("x-api-key", source.APIKey)
			} else {
				request.Header.Set("Authorization", "Bearer "+source.APIKey)
			}
		}
		for name, value := range source.Headers {
			request.Header.Set(name, value)
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, &model.Error{Code: "MRK-2001", Cause: err}
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 16<<20+1))
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, &model.Error{Code: "MRK-2001", Status: response.StatusCode}
		}
		if readErr != nil {
			return nil, &model.Error{Code: "MRK-2001", Cause: readErr}
		}
		if len(data) > 16<<20 {
			return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("catalog response too large")}
		}
		if source.Provider == "openrouter" {
			return openRouterModels(data)
		}
		if source.Protocol == "openai" {
			var page struct {
				Data []struct {
					ID     string `json:"id"`
					Window *int   `json:"context_length"`
					Output *int   `json:"max_output_tokens"`
				} `json:"data"`
			}
			if err := json.Unmarshal(data, &page); err != nil {
				return nil, &model.Error{Code: "MRK-2001", Cause: err}
			}
			for _, item := range page.Data {
				if item.ID == "" {
					return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("missing model id")}
				}
				result = append(result, Override{Provider: source.Provider, ID: item.ID, Window: item.Window, MaxOutput: item.Output})
			}
			return result, nil
		}
		var page struct {
			Data []anthropicModel `json:"data"`
			More bool             `json:"has_more"`
			Last string           `json:"last_id"`
		}
		if err := json.Unmarshal(data, &page); err != nil {
			return nil, &model.Error{Code: "MRK-2001", Cause: err}
		}
		for _, item := range page.Data {
			if item.ID == "" {
				return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("missing model id")}
			}
			override := item.override()
			override.Provider = source.Provider
			result = append(result, override)
		}
		if !page.More {
			return result, nil
		}
		if page.Last == "" || seen[page.Last] {
			return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("invalid catalog cursor")}
		}
		cursor = page.Last
		seen[cursor] = true
	}
}

func openRouterModels(data []byte) ([]Override, error) {
	var page struct {
		Data []struct {
			ID     string `json:"id"`
			Window *int   `json:"context_length"`
			Top    struct {
				Output *int `json:"max_completion_tokens"`
			} `json:"top_provider"`
			Pricing      map[string]string `json:"pricing"`
			Architecture *struct {
				Input []string `json:"input_modalities"`
			} `json:"architecture"`
			Parameters []string `json:"supported_parameters"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, &model.Error{Code: "MRK-2001", Cause: err}
	}
	var result []Override
	for _, item := range page.Data {
		if item.ID == "" {
			return nil, &model.Error{Code: "MRK-2001", Cause: errors.New("missing model id")}
		}
		o := Override{Provider: "openrouter", ID: item.ID, Window: item.Window, MaxOutput: item.Top.Output}
		price := Price{Currency: "USD"}
		valid := true
		for _, field := range []struct {
			name     string
			value    *float64
			required bool
		}{
			{"prompt", &price.Input, true}, {"completion", &price.Output, true}, {"input_cache_read", &price.CacheRead, false}, {"input_cache_write", &price.CacheWrite, false},
		} {
			raw, exists := item.Pricing[field.name]
			if !exists && !field.required {
				continue
			}
			rate, err := strconv.ParseFloat(raw, 64)
			if err != nil || rate < 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
				valid = false
				break
			}
			*field.value = rate * 1000000
		}
		if valid {
			o.Price = &price
		}
		if item.Architecture != nil {
			o.Caps = &Caps{Tools: slices.Contains(item.Parameters, "tools"), Vision: slices.Contains(item.Architecture.Input, "image"), PDF: slices.Contains(item.Architecture.Input, "file")}
		}
		result = append(result, o)
	}
	return result, nil
}

type supported struct {
	Supported bool `json:"supported"`
}
type anthropicModel struct {
	ID           string `json:"id"`
	Window       *int   `json:"max_input_tokens"`
	Output       *int   `json:"max_tokens"`
	Capabilities *struct {
		Image    supported            `json:"image_input"`
		PDF      supported            `json:"pdf_input"`
		Effort   map[string]supported `json:"effort"`
		Thinking struct {
			Types map[string]supported `json:"types"`
		} `json:"thinking"`
	} `json:"capabilities"`
}

func (m anthropicModel) override() Override {
	o := Override{Provider: "anthropic", ID: m.ID, Window: m.Window, MaxOutput: m.Output}
	if m.Capabilities == nil {
		return o
	}
	o.Caps = &Caps{Tools: true, Vision: m.Capabilities.Image.Supported, PDF: m.Capabilities.PDF.Supported}
	var levels []model.Thinking
	if m.Capabilities.Thinking.Types["disabled"].Supported {
		levels = append(levels, model.ThinkingOff)
	}
	for _, level := range []model.Thinking{model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax} {
		if m.Capabilities.Effort[string(level)].Supported {
			levels = append(levels, level)
		}
	}
	if len(levels) > 0 {
		o.Thinking = &levels
	}
	return o
}
