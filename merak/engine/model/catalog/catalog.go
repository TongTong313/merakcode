// Package catalog provides model limits, supported thinking levels and published list prices.
package catalog

import (
	"slices"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Model struct {
	Provider  string           `json:"provider"`
	ID        string           `json:"id"`
	Window    int              `json:"window"`
	MaxOutput int              `json:"maxOutput"`
	Price     Price            `json:"price"`
	Caps      Caps             `json:"caps"`
	Thinking  []model.Thinking `json:"thinking"`
	Source    string           `json:"source"`
	Unknown   []string         `json:"unknown,omitempty"`
}

type Caps struct {
	Tools  bool `json:"tools"`
	Vision bool `json:"vision"`
	PDF    bool `json:"pdf"`
}

// Price stores list rates per million tokens; an empty currency means the price is unknown.
type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Currency   string  `json:"currency,omitempty"`
	Tiers      []Tier  `json:"tiers,omitempty"`
}

type Tier struct {
	MaxInput  int   `json:"maxInput,omitempty"`
	MaxOutput int   `json:"maxOutput,omitempty"`
	Price     Price `json:"price"`
}

func (p Price) Apply(u model.Usage) model.Usage {
	for _, tier := range p.Tiers {
		if (tier.MaxInput == 0 || u.Input <= tier.MaxInput) && (tier.MaxOutput == 0 || u.Output <= tier.MaxOutput) {
			p = tier.Price
			break
		}
	}
	u.CostKnown = p.Currency != ""
	u.Currency = p.Currency
	u.Cost = (float64(max(0, u.Input-u.CacheRead-u.CacheWrite))*p.Input + float64(u.Output)*p.Output + float64(u.CacheRead)*p.CacheRead + float64(u.CacheWrite)*p.CacheWrite) / 1000000
	return u
}

type Catalog struct {
	mu                sync.RWMutex
	models            []Model
	sources           []Source
	configuredSources []Source
	overrides         []Override
	configured        []Override
}

func New(options ...Options) *Catalog {
	c := &Catalog{models: builtins()}
	for _, o := range options {
		c.sources = append(c.sources, o.Sources...)
		for _, override := range o.Overrides {
			c.overrides = append(c.overrides, override.copy())
		}
	}
	return c
}

func (c *Catalog) Get(provider, id string) Model {
	c.mu.RLock()
	defer c.mu.RUnlock()
	m := c.get(provider, id)
	for _, override := range append(slices.Clone(c.overrides), c.configured...) {
		if override.Provider == provider && override.ID == id {
			m = override.apply(m, "override")
		}
	}
	return m
}

func (c *Catalog) get(provider, id string) Model {
	for _, m := range c.models {
		if m.Provider == provider && m.ID == id {
			return clone(m, provider, id)
		}
	}
	for i := len(c.models) - 1; i >= 0; i-- {
		m := c.models[i]
		if m.ID == id || m.Provider+"/"+m.ID == id {
			return clone(m, provider, id)
		}
	}
	return Model{Provider: provider, ID: id, Window: 128000, MaxOutput: 8192, Source: "unknown", Unknown: []string{"window", "maxOutput", "price", "thinking", "caps"}}
}

func clone(m Model, provider, id string) Model {
	m.Provider, m.ID = provider, id
	m.Thinking = slices.Clone(m.Thinking)
	m.Unknown = slices.Clone(m.Unknown)
	m.Price.Tiers = slices.Clone(m.Price.Tiers)
	return m
}

func (m Model) Clamp(requested model.Thinking) model.Thinking {
	if requested == "" || len(m.Thinking) == 0 {
		return requested
	}
	levels := []model.Thinking{model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax}
	target := slices.Index(levels, requested)
	best, distance := m.Thinking[0], len(levels)+1
	for _, level := range m.Thinking {
		if requested != model.ThinkingOff && level == model.ThinkingOff && len(m.Thinking) > 1 {
			continue
		}
		d := slices.Index(levels, level) - target
		if d < 0 {
			d = -d
		}
		if d < distance {
			best, distance = level, d
		}
	}
	return best
}

// List returns independent values in provider/model order.
func (c *Catalog) List(overrides ...Override) []Model {
	c.mu.RLock()
	keys := make(map[[2]string]bool)
	for _, m := range c.models {
		keys[[2]string{m.Provider, m.ID}] = true
	}
	for _, m := range append(slices.Clone(c.overrides), c.configured...) {
		keys[[2]string{m.Provider, m.ID}] = true
	}
	c.mu.RUnlock()
	for _, o := range overrides {
		keys[[2]string{o.Provider, o.ID}] = true
	}
	result := make([]Model, 0, len(keys))
	for key := range keys {
		value := c.Get(key[0], key[1])
		for _, o := range overrides {
			if o.Provider == key[0] && o.ID == key[1] {
				value = o.apply(value, "override")
			}
		}
		result = append(result, value)
	}
	slices.SortFunc(result, func(a, b Model) int { return strings.Compare(a.Provider+"/"+a.ID, b.Provider+"/"+b.ID) })
	return result
}

// Configure replaces runtime user overrides while preserving built-in and file-based catalog data.
func (c *Catalog) Configure(overrides []Override) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configured = nil
	for _, override := range overrides {
		c.configured = append(c.configured, override.copy())
	}
}
