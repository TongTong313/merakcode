package model

import "slices"

type Collector struct {
	parts     []Part
	call      *ToolCall
	calls     map[string]*ToolCall
	usage     Usage
	stop      StopReason
	reasoning *Reasoning
	dropped   []string
}

func (c *Collector) Add(chunk Chunk) {
	switch chunk.Kind {
	case DroppedChunk:
		if chunk.Dropped != "" && !slices.Contains(c.dropped, chunk.Dropped) {
			c.dropped = append(c.dropped, chunk.Dropped)
		}
	case Text:
		c.reasoning = nil
		if len(c.parts) == 0 || c.parts[len(c.parts)-1].ToolCall != nil || c.parts[len(c.parts)-1].Reasoning != nil {
			c.parts = append(c.parts, Part{})
		}
		c.parts[len(c.parts)-1].Text += chunk.Text
	case ReasoningChunk:
		if chunk.Reasoning == nil {
			break
		}
		if c.reasoning == nil {
			c.reasoning = &Reasoning{Provider: chunk.Reasoning.Provider}
			c.parts = append(c.parts, Part{Reasoning: c.reasoning})
		}
		c.reasoning.Text += chunk.Reasoning.Text
		if len(chunk.Reasoning.Opaque) > 0 {
			c.reasoning.Opaque = append([]byte(nil), chunk.Reasoning.Opaque...)
			c.reasoning = nil
		}
	case ToolCallStart:
		c.reasoning = nil
		if chunk.ToolCall != nil {
			call := *chunk.ToolCall
			call.Input = append([]byte(nil), call.Input...)
			c.call = &call
			if c.calls == nil {
				c.calls = make(map[string]*ToolCall)
			}
			c.calls[call.ID] = c.call
			c.parts = append(c.parts, Part{ToolCall: c.call})
		}
	case ToolCallDelta:
		call := c.call
		if chunk.ToolCall != nil {
			call = c.calls[chunk.ToolCall.ID]
		}
		if call != nil {
			call.Input = append(call.Input, chunk.Text...)
		}
	case ToolCallEnd:
		c.call = nil
	case Stop:
		c.stop = chunk.Stop
	case UsageChunk:
		if chunk.Usage != nil {
			c.usage = *chunk.Usage
		}
	}
}

func (c *Collector) Dropped() []string { return slices.Clone(c.dropped) }

func (c *Collector) Message() (Message, Usage, StopReason) {
	return Message{Role: Assistant, Parts: c.parts}, c.usage, c.stop
}
