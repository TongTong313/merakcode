package anthropic

import (
	"encoding/json"
	"io"

	"github.com/TongTong313/merakcode/merak/engine/model"
	sdk "github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/packages/ssestream"
)

type block struct {
	kind, id, signature string
	initialInput        string
	input               bool
}

type stream struct {
	raw      *ssestream.Stream[sdk.MessageStreamEventUnion]
	queue    []model.Chunk
	usage    model.Usage
	blocks   map[int64]*block
	done     bool
	provider string
}

func (s *stream) Close() error { return s.raw.Close() }

func (s *stream) Recv() (model.Chunk, error) {
	for len(s.queue) == 0 {
		if s.done {
			return model.Chunk{}, io.EOF
		}
		if !s.raw.Next() {
			if err := s.raw.Err(); err != nil {
				return model.Chunk{}, providerError(err)
			}
			return model.Chunk{}, providerError(io.ErrUnexpectedEOF)
		}
		s.accept(s.raw.Current())
	}
	chunk := s.queue[0]
	s.queue = s.queue[1:]
	return chunk, nil
}

func (s *stream) accept(e sdk.MessageStreamEventUnion) {
	switch e.Type {
	case "message_start":
		u := e.Message.Usage
		s.usage = model.Usage{Input: int(u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens), Output: int(u.OutputTokens), CacheRead: int(u.CacheReadInputTokens), CacheWrite: int(u.CacheCreationInputTokens)}
		s.emitUsage()
	case "content_block_start":
		b := e.ContentBlock
		s.blocks[e.Index] = &block{kind: b.Type, id: b.ID, signature: b.Signature, initialInput: b.JSON.Input.Raw()}
		switch b.Type {
		case "text":
			s.queue = append(s.queue, model.Chunk{Kind: model.Text, Text: b.Text})
			if len(b.Citations) > 0 {
				s.queue = append(s.queue, model.Chunk{Kind: model.DroppedChunk, Dropped: "citations"})
			}
		case "thinking":
			s.queue = append(s.queue, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: b.Thinking, Provider: s.provider}})
		case "redacted_thinking":
			s.queue = append(s.queue, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Provider: s.provider, Opaque: []byte(b.RawJSON())}})
		case "tool_use":
			s.queue = append(s.queue, model.Chunk{Kind: model.ToolCallStart, ToolCall: &model.ToolCall{ID: b.ID, Name: b.Name}})
		default:
			s.queue = append(s.queue, model.Chunk{Kind: model.DroppedChunk, Dropped: b.Type})
		}
	case "content_block_delta":
		b := s.blocks[e.Index]
		if b == nil {
			return
		}
		switch e.Delta.Type {
		case "text_delta":
			s.queue = append(s.queue, model.Chunk{Kind: model.Text, Text: e.Delta.Text})
		case "thinking_delta":
			s.queue = append(s.queue, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: e.Delta.Thinking, Provider: s.provider}})
		case "signature_delta":
			b.signature += e.Delta.Signature
		case "input_json_delta":
			b.input = true
			s.queue = append(s.queue, model.Chunk{Kind: model.ToolCallDelta, Text: e.Delta.PartialJSON, ToolCall: &model.ToolCall{ID: b.id}})
		case "citations_delta":
			s.queue = append(s.queue, model.Chunk{Kind: model.DroppedChunk, Dropped: "citations"})
		}
	case "content_block_stop":
		b := s.blocks[e.Index]
		if b == nil {
			return
		}
		switch b.kind {
		case "thinking":
			opaque, _ := json.Marshal(b.signature)
			s.queue = append(s.queue, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Opaque: opaque, Provider: s.provider}})
		case "tool_use":
			if !b.input {
				input := b.initialInput
				if input == "" {
					input = "{}"
				}
				s.queue = append(s.queue, model.Chunk{Kind: model.ToolCallDelta, Text: input, ToolCall: &model.ToolCall{ID: b.id}})
			}
			s.queue = append(s.queue, model.Chunk{Kind: model.ToolCallEnd, ToolCall: &model.ToolCall{ID: b.id}})
		}
		delete(s.blocks, e.Index)
	case "message_delta":
		uncached := s.usage.Input - s.usage.CacheRead - s.usage.CacheWrite
		if e.Usage.JSON.InputTokens.Valid() {
			uncached = int(e.Usage.InputTokens)
		}
		if e.Usage.JSON.CacheReadInputTokens.Valid() {
			s.usage.CacheRead = int(e.Usage.CacheReadInputTokens)
		}
		if e.Usage.JSON.CacheCreationInputTokens.Valid() {
			s.usage.CacheWrite = int(e.Usage.CacheCreationInputTokens)
		}
		s.usage.Input = uncached + s.usage.CacheRead + s.usage.CacheWrite
		s.usage.Output = int(e.Usage.OutputTokens)
		s.emitUsage()
		var reason model.StopReason
		switch e.Delta.StopReason {
		case "end_turn", "stop_sequence":
			reason = model.EndTurn
		case "tool_use":
			reason = model.ToolUse
		case "max_tokens":
			reason = model.MaxTokens
		case "refusal":
			reason = model.Refusal
		}
		if reason != "" {
			s.queue = append(s.queue, model.Chunk{Kind: model.Stop, Stop: reason})
		}
	case "message_stop":
		s.done = true
	}
}

func (s *stream) emitUsage() {
	usage := s.usage
	s.queue = append(s.queue, model.Chunk{Kind: model.UsageChunk, Usage: &usage})
}
