package openai

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type wireChunk struct {
	Error   json.RawMessage `json:"error"`
	Choices []struct {
		Index  int             `json:"index"`
		Delta  json.RawMessage `json:"delta"`
		Finish string          `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		Input    int `json:"prompt_tokens"`
		Output   int `json:"completion_tokens"`
		CacheHit int `json:"prompt_cache_hit_tokens"`
		Cached   int `json:"cached_tokens"`
		Details  struct {
			Cached int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
}

type wireDelta struct {
	Content   string `json:"content"`
	ToolCalls []struct {
		Index    int             `json:"index"`
		ID       string          `json:"id"`
		Extra    json.RawMessage `json:"extra_content"`
		Function struct {
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		} `json:"function"`
	} `json:"tool_calls"`
}

type stream struct {
	body    io.ReadCloser
	scanner *bufio.Scanner
	pending []model.Chunk
	calls   map[int]string
	done    bool
	config  Config
}

func newStream(body io.ReadCloser, config Config) *stream {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	return &stream{body: body, scanner: scanner, calls: make(map[int]string), config: config}
}

func (s *stream) Close() error {
	s.done = true
	return s.body.Close()
}

func (s *stream) Recv() (model.Chunk, error) {
	for len(s.pending) == 0 {
		if s.done {
			return model.Chunk{}, io.EOF
		}
		data, err := s.readEvent()
		if err != nil {
			return model.Chunk{}, &model.Error{Code: "MRK-2001", Cause: err}
		}
		if data == "[DONE]" {
			s.done = true
			return model.Chunk{}, io.EOF
		}
		var wire wireChunk
		if err := json.Unmarshal([]byte(data), &wire); err != nil {
			return model.Chunk{}, &model.Error{Code: "MRK-2001", Cause: err}
		}
		if err := s.decode(wire); err != nil {
			var failure *model.Error
			if errors.As(err, &failure) {
				return model.Chunk{}, failure
			}
			return model.Chunk{}, &model.Error{Code: "MRK-2001", Cause: err}
		}
	}
	chunk := s.pending[0]
	s.pending = s.pending[1:]
	return chunk, nil
}

func (s *stream) readEvent() (string, error) {
	var data []string
	for s.scanner.Scan() {
		line := s.scanner.Text()
		if line == "" && len(data) > 0 {
			return strings.Join(data, "\n"), nil
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := s.scanner.Err(); err != nil {
		return "", err
	}
	if len(data) > 0 {
		return strings.Join(data, "\n"), nil
	}
	return "", io.ErrUnexpectedEOF
}

func (s *stream) decode(wire wireChunk) error {
	if len(wire.Error) > 0 && string(wire.Error) != "null" {
		var detail struct {
			Status int    `json:"status"`
			Type   string `json:"type"`
		}
		if err := json.Unmarshal(wire.Error, &detail); err != nil {
			return err
		}
		if detail.Status == 0 {
			switch detail.Type {
			case "server_error", "overloaded_error":
				detail.Status = 503
			case "rate_limit_error":
				detail.Status = 429
			}
		}
		return &model.Error{Code: "MRK-2001", Status: detail.Status}
	}
	for _, choice := range wire.Choices {
		if choice.Index != 0 {
			continue
		}
		var delta wireDelta
		if len(choice.Delta) > 0 {
			if err := json.Unmarshal(choice.Delta, &delta); err != nil {
				return err
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(choice.Delta, &fields); err != nil {
				return err
			}
			var dropped []string
			for key, raw := range fields {
				if key != "role" && key != "content" && key != "tool_calls" && key != s.config.ReasoningField && string(raw) != "null" {
					dropped = append(dropped, key)
				}
			}
			sort.Strings(dropped)
			for _, kind := range dropped {
				s.pending = append(s.pending, model.Chunk{Kind: model.DroppedChunk, Dropped: kind})
			}
			if raw := fields[s.config.ReasoningField]; len(raw) > 0 {
				var reasoning string
				if err := json.Unmarshal(raw, &reasoning); err != nil {
					return err
				}
				if reasoning != "" {
					s.pending = append(s.pending, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Text: reasoning, Provider: s.config.Name}})
				}
			}
		}
		if delta.Content != "" {
			s.pending = append(s.pending, model.Chunk{Kind: model.Text, Text: delta.Content})
		}
		for _, call := range delta.ToolCalls {
			if call.ID != "" {
				s.calls[call.Index] = call.ID
				s.pending = append(s.pending, model.Chunk{Kind: model.ToolCallStart, ToolCall: &model.ToolCall{ID: call.ID, Name: call.Function.Name}})
			}
			id := s.calls[call.Index]
			if id == "" {
				return errors.New("MRK-2001: tool delta has no call id")
			}
			if call.Function.Arguments != "" {
				s.pending = append(s.pending, model.Chunk{Kind: model.ToolCallDelta, Text: call.Function.Arguments, ToolCall: &model.ToolCall{ID: id}})
			}
			if s.config.Name == "gemini" && len(call.Extra) > 0 && string(call.Extra) != "null" {
				opaque, _ := json.Marshal(callSignature{CallID: id, Extra: call.Extra})
				s.pending = append(s.pending, model.Chunk{Kind: model.ReasoningChunk, Reasoning: &model.Reasoning{Provider: s.config.Name, Opaque: opaque}})
			}
		}
		if choice.Finish != "" {
			var indices []int
			for index := range s.calls {
				indices = append(indices, index)
			}
			sort.Ints(indices)
			for _, index := range indices {
				s.pending = append(s.pending, model.Chunk{Kind: model.ToolCallEnd, ToolCall: &model.ToolCall{ID: s.calls[index]}})
			}
			stop := map[string]model.StopReason{"stop": model.EndTurn, "tool_calls": model.ToolUse, "length": model.MaxTokens, "content_filter": model.Refusal}[choice.Finish]
			if stop == "" {
				return errors.New("MRK-2001: unknown finish reason")
			}
			s.pending = append(s.pending, model.Chunk{Kind: model.Stop, Stop: stop})
		}
	}
	if wire.Usage != nil {
		cached := max(wire.Usage.Details.Cached, wire.Usage.CacheHit, wire.Usage.Cached)
		s.pending = append(s.pending, model.Chunk{Kind: model.UsageChunk, Usage: &model.Usage{
			Input: wire.Usage.Input, Output: wire.Usage.Output, CacheRead: cached,
		}})
	}
	return nil
}
