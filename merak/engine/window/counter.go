// Package window estimates and bounds the context supplied to model requests.
package window

import (
	"encoding/json"
	"math"
	"strings"
	"sync"
	"unicode"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Estimate struct {
	System   int `json:"system"`
	Tools    int `json:"tools"`
	Messages int `json:"messages"`
	Total    int `json:"total"`
}

type Counter struct {
	mu      sync.Mutex
	factors map[[2]string]float64
}

// EstimateText is a cheap tokenizer heuristic, not a provider tokenizer.
func EstimateText(text string) int {
	runes := []rune(text)
	count := 0
	for i := 0; i < len(runes); {
		r := runes[i]
		if r < 128 && unicode.IsLetter(r) {
			start := i
			for i < len(runes) && runes[i] < 128 && unicode.IsLetter(runes[i]) {
				i++
			}
			count += (i - start + 3) / 4
			continue
		}
		if r >= '0' && r <= '9' {
			start := i
			for i < len(runes) && runes[i] >= '0' && runes[i] <= '9' {
				i++
			}
			count += (i - start + 2) / 3
			continue
		}
		if unicode.IsSpace(r) {
			start := i
			for i < len(runes) && unicode.IsSpace(runes[i]) {
				i++
			}
			if i-start > 1 || r != ' ' || i < len(runes) && unicode.IsDigit(runes[i]) {
				count += (i - start + 3) / 4
			}
			continue
		}
		count++
		if r > 0xffff {
			count++
		}
		i++
	}
	return count
}

func (c *Counter) Estimate(provider string, request model.Request) Estimate {
	value := estimate(request)
	c.mu.Lock()
	factor := c.factors[[2]string{provider, request.Model}]
	c.mu.Unlock()
	if factor == 0 {
		factor = 1
	}
	value.System = int(math.Ceil(float64(value.System) * factor))
	value.Tools = int(math.Ceil(float64(value.Tools) * factor))
	value.Messages = int(math.Ceil(float64(value.Messages) * factor))
	value.Total = value.System + value.Tools + value.Messages
	return value
}

// Observe uses total input, which already includes cache reads and writes.
func (c *Counter) Observe(provider string, request model.Request, usage model.Usage) {
	baseline := estimate(request).Total
	if usage.Input <= 0 || baseline == 0 {
		return
	}
	ratio := min(4, max(.25, float64(usage.Input)/float64(baseline)))
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.factors == nil {
		c.factors = make(map[[2]string]float64)
	}
	key := [2]string{provider, request.Model}
	if previous := c.factors[key]; previous > 0 {
		ratio = previous*.8 + ratio*.2
	}
	c.factors[key] = ratio
}

func estimate(request model.Request) Estimate {
	value := Estimate{Messages: 3}
	if request.System != "" {
		value.System = 4 + EstimateText(request.System)
	}
	for _, spec := range request.Tools {
		body, _ := json.Marshal(spec)
		value.Tools += 4 + EstimateText(string(body))
	}
	for _, message := range request.Messages {
		value.Messages += 4 + estimateParts(message.Parts)
	}
	value.Total = value.System + value.Tools + value.Messages
	return value
}

func estimateParts(parts []model.Part) int {
	count := 0
	for _, part := range parts {
		count += EstimateText(part.Text)
		if part.Image != nil {
			// Until provider usage calibrates the estimate, reserve a large image allowance.
			count += max(4096, (len(part.Image.Data)+2)/3)
		}
		if part.Document != nil {
			if strings.HasPrefix(part.Document.MIME, "text/") {
				count += EstimateText(string(part.Document.Data))
			} else {
				count += max(4096, len(part.Document.Data))
			}
		}
		if part.Reasoning != nil {
			count += EstimateText(part.Reasoning.Text) + (len(part.Reasoning.Opaque)+3)/4
		}
		if part.ToolCall != nil {
			count += 4 + EstimateText(part.ToolCall.ID) + EstimateText(part.ToolCall.Name) + EstimateText(string(part.ToolCall.Input))
		}
		if part.ToolResult != nil {
			count += 4 + EstimateText(part.ToolResult.CallID) + estimateParts(part.ToolResult.Parts)
		}
	}
	return count
}
