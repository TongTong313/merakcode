package server

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type approval struct {
	reply chan permission.Reply
	owner *websocket.Conn
}

func (s *Server) pendingApproval(id event.ID) *approval {
	if s.approvals[id] == nil {
		s.approvals[id] = &approval{reply: make(chan permission.Reply, 1)}
	}
	return s.approvals[id]
}

func (s *Server) Ask(ctx context.Context, request permission.Request) (permission.Reply, error) {
	s.mu.Lock()
	available := false
	for _, approve := range s.connections {
		if approve {
			available = true
			break
		}
	}
	if !available {
		s.mu.Unlock()
		return permission.Reply{Decision: permission.Deny}, nil
	}
	pending := s.pendingApproval(request.ID)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.approvals, request.ID); s.mu.Unlock() }()
	select {
	case reply := <-pending.reply:
		return reply, nil
	case <-ctx.Done():
		return permission.Reply{}, ctx.Err()
	}
}

func (s *Server) offerApproval(conn *websocket.Conn, id event.ID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.connections[conn] {
		return false
	}
	pending := s.pendingApproval(id)
	if pending.owner == nil {
		pending.owner = conn
	}
	return pending.owner == conn
}

func (s *Server) replyApproval(ctx context.Context, conn *websocket.Conn, params protocol.PermissionReplyParams) error {
	human, err := s.engine.AuthorizePermission(ctx, params.Request, params.Human)
	if err != nil {
		return errors.New("MRK-5002")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.approvals[params.Request]
	if pending == nil || pending.owner != conn || !s.connections[conn] || params.Decision != permission.Allow && params.Decision != permission.Deny {
		return errors.New("MRK-5002")
	}
	select {
	case pending.reply <- permission.Reply{Decision: params.Decision, Human: human}:
		return nil
	default:
		return errors.New("MRK-5002")
	}
}
