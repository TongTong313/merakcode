package enginetest

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
)

// Chooser answers each request by looking at its system prompt, so one provider can serve a parent and its children.
type Chooser struct {
	T       *testing.T
	Mu      sync.Mutex
	Answer  func(model.Request) []model.Chunk
	Reviews []model.Request
}

func (c *Chooser) Name() string { return "fake" }

func (c *Chooser) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	c.Mu.Lock()
	defer c.Mu.Unlock()
	if strings.Contains(req.System, "You are the code reviewer") {
		c.Reviews = append(c.Reviews, req)
	}
	return &chunkStream{chunks: c.Answer(req)}, nil
}

type chunkStream struct{ chunks []model.Chunk }

func (s *chunkStream) Recv() (model.Chunk, error) {
	if len(s.chunks) == 0 {
		return model.Chunk{}, io.EOF
	}
	next := s.chunks[0]
	s.chunks = s.chunks[1:]
	return next, nil
}

func (s *chunkStream) Close() error { return nil }

func Text(value string) []model.Chunk {
	return []model.Chunk{{Kind: model.Text, Text: value}, {Kind: model.Stop, Stop: model.EndTurn}}
}

func Call(id, name string, input any) []model.Chunk {
	body, _ := json.Marshal(input)
	return []model.Chunk{
		{Kind: model.ToolCallStart, ToolCall: &model.ToolCall{ID: id, Name: name}},
		{Kind: model.ToolCallDelta, Text: string(body)},
		{Kind: model.ToolCallEnd},
		{Kind: model.Stop, Stop: model.ToolUse},
	}
}
