package server

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) sessionMethods() map[string]handler {
	return map[string]handler{
		"session.create": run(func(ctx context.Context, _ *connection, params protocol.SessionCreateParams) (any, error) {
			settings := s.configuration()
			if params.Mode == "" {
				params.Mode = permission.Mode(settings.PermissionMode)
			}
			if params.Provider == "" {
				params.Provider, params.Model, _ = strings.Cut(settings.Model, "/")
			}
			if params.Thinking == "" {
				params.Thinking = model.Thinking(settings.Thinking)
			}
			id, err := s.engine.CreateSession(ctx, engine.SessionOptions{Mode: params.Mode, Provider: params.Provider, Model: params.Model, Thinking: params.Thinking, Workdir: params.Workdir, Budget: params.Budget, MCPServers: params.MCPServers})
			return protocol.SessionCreateResult{Session: id}, err
		}),
		"session.send": run(func(ctx context.Context, _ *connection, params protocol.SessionSendParams) (any, error) {
			if params.Selection != nil {
				return done(s.engine.SendWithBudget(ctx, params.Session, params.Parts, params.ExtendBudget, *params.Selection))
			}
			return done(s.engine.SendWithBudget(ctx, params.Session, params.Parts, params.ExtendBudget))
		}),
		"session.cancel": run(func(_ context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return done(s.engine.Cancel(params.Session))
		}),
		"session.list": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return s.engine.ListSessions(ctx)
		}),
		"session.snapshot": run(func(ctx context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return s.engine.SessionSnapshot(ctx, params.Session)
		}),
		"permission.reply": run(func(ctx context.Context, c *connection, params protocol.PermissionReplyParams) (any, error) {
			return done(s.replyApproval(ctx, c.ws, c.human, params))
		}),
		"question.reply": run(func(ctx context.Context, c *connection, params protocol.QuestionReplyParams) (any, error) {
			return done(s.replyQuestion(ctx, c.ws, c.human, params))
		}),
		"worker.run": run(func(ctx context.Context, _ *connection, params protocol.WorkerRunParams) (any, error) {
			if params.Session == "" || params.Workdir == "" {
				return nil, errors.New("worker session and workdir are required")
			}
			started, err := s.engine.StartWorker(ctx, params.Profile, worker.Assignment{Session: params.Session, Workdir: params.Workdir, Packet: params.Packet})
			if err != nil {
				return nil, err
			}
			// Drain the runner subscription; connection filters forward the same bus events.
			for range started.Events() {
			}
			return started.Wait(ctx)
		}),
		"sandbox.status": run(func(ctx context.Context, _ *connection, params protocol.SandboxStatusParams) (any, error) {
			if params.Group != "" {
				return s.engine.MemberSandboxStatus(ctx, params.Group, params.Member, params.Session)
			}
			return s.engine.SandboxStatus(ctx, params.Workdir, params.Mode, params.Session)
		}),
		"sandbox.setup": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return done(s.engine.SetupSandbox(ctx))
		}),
		"engine.status": run(func(_ context.Context, _ *connection, _ struct{}) (any, error) {
			s.mu.Lock()
			defer s.mu.Unlock()
			return protocol.EngineStatus{PID: os.Getpid(), Clients: len(s.connections)}, nil
		}),
		"engine.stop": run(func(_ context.Context, _ *connection, _ struct{}) (any, error) { return nil, nil }),
	}
}

var _ = event.ID("")
