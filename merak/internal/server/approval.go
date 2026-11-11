package server

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type approval struct {
	answered bool
	group    bool
	reply    chan permission.Reply
	owner    *websocket.Conn
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
	if !available && request.Call.Env.Scope.Group == "" && request.Kind != "workspace" {
		s.mu.Unlock()
		return permission.Reply{Decision: permission.Deny}, nil
	}
	pending := s.pendingApproval(request.ID)
	pending.group = request.Call.Env.Scope.Group != "" || request.Kind == "workspace"
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.approvals, request.ID); s.mu.Unlock() }()
	select {
	case reply := <-pending.reply:
		return reply, nil
	case <-ctx.Done():
		return permission.Reply{}, ctx.Err()
	}
}

func (s *Server) offerPendingApprovals(ctx context.Context, conn *websocket.Conn) error {
	facts, err := s.engine.PendingPermissions(ctx)
	if err != nil {
		return err
	}
	for _, fact := range facts {
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return err
		}
		persistent := fact.Scope.Group != "" || request.Kind == "workspace"
		if !s.offerApproval(conn, fact.ID, persistent) {
			continue
		}
		s.mu.Lock()
		if pending := s.approvals[fact.ID]; pending != nil {
			pending.group = persistent
		}
		s.mu.Unlock()
		payload, _ := json.Marshal(fact)
		body, _ := json.Marshal(protocol.Message{JSONRPC: "2.0", Method: "event", Params: payload})
		if err := conn.Write(body); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) offerApproval(conn *websocket.Conn, id event.ID, grouped bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.connections[conn] {
		return false
	}
	pending := s.pendingApproval(id)
	pending.group = pending.group || grouped
	if pending.answered {
		return false
	}
	if pending.owner == nil {
		pending.owner = conn
	}
	return pending.owner == conn
}

func (s *Server) replyApproval(ctx context.Context, conn *websocket.Conn, caller event.ID, params protocol.PermissionReplyParams) error {
	if params.Remember != "" && params.Remember != "session" && params.Remember != "always" {
		return errors.New("MRK-5002")
	}
	human, err := s.engine.AuthorizePermission(ctx, params.Request, caller)
	if err != nil {
		return errors.New("MRK-5002")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.approvals[params.Request]
	if pending == nil || pending.answered || pending.owner != conn || !s.connections[conn] || params.Decision != permission.Allow && params.Decision != permission.Deny {
		return errors.New("MRK-5002")
	}
	select {
	case pending.reply <- permission.Reply{Decision: params.Decision, Human: human, Remember: params.Remember}:
		pending.answered = true
		return nil
	default:
		return errors.New("MRK-5002")
	}
}
