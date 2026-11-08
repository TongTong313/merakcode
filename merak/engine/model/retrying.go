package model

import (
	"context"
	"errors"
	"time"
)

// Retrying retries transient failures before visible output and prices each attempt independently.
type Retrying struct {
	Provider Provider
	Price    func(string, Usage) Usage
}

func (p *Retrying) Name() string { return p.Provider.Name() }

func (p *Retrying) Stream(ctx context.Context, req Request) (Stream, error) {
	ctx, cancel := context.WithCancel(ctx)
	s := &retryStream{ctx: ctx, cancel: cancel, owner: p, request: req}
	if err := s.open(); err != nil {
		cancel()
		return nil, err
	}
	return s, nil
}

type retryStream struct {
	ctx      context.Context
	cancel   context.CancelFunc
	owner    *Retrying
	request  Request
	stream   Stream
	attempt  int
	visible  bool
	previous Usage
	current  Usage
}

func (s *retryStream) open() error {
	for {
		if err := s.ctx.Err(); err != nil {
			return err
		}
		if s.attempt > 0 {
			timer := time.NewTimer(100 * time.Millisecond << (s.attempt - 1))
			select {
			case <-s.ctx.Done():
				timer.Stop()
				return s.ctx.Err()
			case <-timer.C:
			}
		}
		s.attempt++
		stream, err := s.owner.Provider.Stream(s.ctx, s.request)
		if err == nil {
			s.stream = stream
			return nil
		}
		if !s.retryable(err) {
			return err
		}
	}
}

func (s *retryStream) Recv() (Chunk, error) {
	for {
		chunk, err := s.stream.Recv()
		if err != nil {
			if !s.retryable(err) {
				return Chunk{}, err
			}
			s.stream.Close()
			s.previous = s.previous.Add(s.current)
			s.current = Usage{}
			if err := s.open(); err != nil {
				return Chunk{}, err
			}
			continue
		}
		if chunk.Kind == UsageChunk && chunk.Usage != nil {
			s.current = *chunk.Usage
			if s.owner.Price != nil {
				s.current = s.owner.Price(s.request.Model, s.current)
			}
			total := s.previous.Add(s.current)
			chunk.Usage = &total
		} else {
			s.visible = true
		}
		return chunk, nil
	}
}

func (s *retryStream) retryable(err error) bool {
	if s.ctx.Err() != nil || s.attempt >= 3 || s.visible {
		return false
	}
	var failure *Error
	return errors.As(err, &failure) && (failure.Status == 429 || failure.Status >= 500 && failure.Status <= 599)
}

func (s *retryStream) Close() error {
	s.cancel()
	return s.stream.Close()
}

func (a Usage) Add(b Usage) Usage {
	if b == (Usage{}) {
		return a
	}
	if a.Input+a.Output+a.CacheRead+a.CacheWrite > 0 {
		b.CostKnown = a.CostKnown && b.CostKnown && a.Currency == b.Currency
		if a.Currency != b.Currency {
			b.Currency = ""
		}
	}
	b.Input += a.Input
	b.Output += a.Output
	b.CacheRead += a.CacheRead
	b.CacheWrite += a.CacheWrite
	b.Cost += a.Cost
	if !b.CostKnown {
		b.Cost = 0
	}
	return b
}
