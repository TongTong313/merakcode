// Package fake supplies a provider that replies from a deterministic script.
package fake

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/model"
)

type Reply struct {
	Text   string                    `json:"text"`
	Calls  []model.ToolCall          `json:"calls,omitempty"`
	Expect func(model.Request) error `json:"-"`
	Hold   <-chan struct{}           `json:"-"`
	Usage  *model.Usage              `json:"usage,omitempty"`
}

type provider struct {
	mu      sync.Mutex
	test    testing.TB
	replies []Reply
	next    int
}

func New(t testing.TB, replies ...Reply) model.Provider {
	return &provider{test: t, replies: append([]Reply(nil), replies...)}
}

func (p *provider) Name() string { return "fake" }

func (p *provider) Stream(ctx context.Context, req model.Request) (model.Stream, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if p.next >= len(p.replies) {
		if p.test != nil {
			p.test.Errorf("fake: script exhausted at request %d", p.next+1)
		}
		return nil, errors.New("fake: script exhausted")
	}
	reply := p.replies[p.next]
	p.next++
	if reply.Expect != nil {
		if err := reply.Expect(req); err != nil {
			if p.test != nil {
				p.test.Errorf("fake: request %d: %v", p.next, err)
			}
			return nil, err
		}
	}
	var chunks []model.Chunk
	if reply.Text != "" {
		chunks = append(chunks, model.Chunk{Kind: model.Text, Text: reply.Text})
	}
	stop := model.EndTurn
	for _, call := range reply.Calls {
		chunks = append(chunks,
			model.Chunk{Kind: model.ToolCallStart, ToolCall: &model.ToolCall{ID: call.ID, Name: call.Name}},
			model.Chunk{Kind: model.ToolCallDelta, Text: string(call.Input)},
			model.Chunk{Kind: model.ToolCallEnd},
		)
		stop = model.ToolUse
	}
	if reply.Usage != nil {
		usage := *reply.Usage
		chunks = append(chunks, model.Chunk{Kind: model.UsageChunk, Usage: &usage})
	}
	chunks = append(chunks, model.Chunk{Kind: model.Stop, Stop: stop})
	return &stream{ctx: ctx, chunks: chunks, hold: reply.Hold}, nil
}

type stream struct {
	ctx    context.Context
	chunks []model.Chunk
	hold   <-chan struct{}
}

func (s *stream) Recv() (model.Chunk, error) {
	if s.hold != nil {
		select {
		case <-s.hold:
			s.hold = nil
		case <-s.ctx.Done():
			return model.Chunk{}, s.ctx.Err()
		}
	}
	if err := s.ctx.Err(); err != nil {
		return model.Chunk{}, err
	}
	if len(s.chunks) == 0 {
		return model.Chunk{}, io.EOF
	}
	chunk := s.chunks[0]
	s.chunks = s.chunks[1:]
	return chunk, nil
}

func (s *stream) Close() error {
	s.chunks = nil
	return nil
}
