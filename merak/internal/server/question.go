package server

import (
	"context"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type pendingQuestion struct {
	reply chan question.Answer
	owner *websocket.Conn
}

func (s *Server) question(id event.ID) *pendingQuestion {
	if s.questions[id] == nil {
		s.questions[id] = &pendingQuestion{reply: make(chan question.Answer, 1)}
	}
	return s.questions[id]
}

func (s *Server) AskQuestion(ctx context.Context, request question.Request) (question.Answer, error) {
	s.mu.Lock()
	available := false
	for _, approve := range s.connections {
		available = available || approve
	}
	if !available {
		s.mu.Unlock()
		return question.Answer{Cancelled: true}, nil
	}
	pending := s.question(request.ID)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.questions, request.ID); s.mu.Unlock() }()
	select {
	case answer := <-pending.reply:
		return answer, nil
	case <-ctx.Done():
		return question.Answer{}, ctx.Err()
	}
}

func (s *Server) offerQuestion(conn *websocket.Conn, id event.ID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.connections[conn] {
		return false
	}
	pending := s.question(id)
	if pending.owner == nil {
		pending.owner = conn
	}
	return pending.owner == conn
}

func (s *Server) replyQuestion(ctx context.Context, conn *websocket.Conn, params protocol.QuestionReplyParams) error {
	human, err := s.engine.AuthorizeQuestion(ctx, params.Request, params.Human)
	if err != nil {
		return errors.New("MRK-5002")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.questions[params.Request]
	if pending == nil || pending.owner != conn || !s.connections[conn] || !params.Cancelled && strings.TrimSpace(params.Text) == "" {
		return errors.New("MRK-5002")
	}
	select {
	case pending.reply <- question.Answer{Text: params.Text, Cancelled: params.Cancelled, Human: human}:
		return nil
	default:
		return errors.New("MRK-5002")
	}
}
