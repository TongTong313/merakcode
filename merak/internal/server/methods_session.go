package server

import (
	"context"
	"errors"
	"os"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) sessionMethods() map[string]handler {
	return map[string]handler{
		"session.create": run(func(ctx context.Context, _ *connection, params protocol.SessionCreateParams) (any, error) {
			if params.Workdir == "" {
				return nil, &engine.Error{Code: errorcode.WorkspaceInvalid, Err: errors.New("a conversation needs a workspace folder")}
			}
			settings := s.configuration()
			if params.Mode == "" {
				params.Mode = permission.Mode(settings.PermissionMode)
			}
			if params.Thinking == "" {
				params.Thinking = model.Thinking(settings.Thinking)
			}
			id, err := s.engine.CreateSession(ctx, engine.SessionOptions{Key: params.Key, Agent: params.Agent, Mode: params.Mode, Provider: params.Provider, Model: params.Model, Thinking: params.Thinking, Workdir: params.Workdir, Budget: params.Budget, MCPServers: params.MCPServers})
			return protocol.SessionCreateResult{Session: id}, err
		}),
		"session.command": run(func(ctx context.Context, _ *connection, params protocol.SessionCommandParams) (any, error) {
			return s.engine.RunCommand(ctx, params.Session, params.Name, params.Arguments)
		}),
		"plan.get": run(func(ctx context.Context, _ *connection, params protocol.PlanParams) (any, error) {
			return s.engine.GetPlan(ctx, params.Session)
		}),
		"plan.save": run(func(ctx context.Context, _ *connection, params protocol.PlanSaveParams) (any, error) {
			return s.engine.SavePlan(ctx, params.Session, params.Content, params.Revision)
		}),
		"plan.execute": run(func(ctx context.Context, _ *connection, params protocol.PlanParams) (any, error) {
			return s.engine.ExecutePlan(ctx, params.Session)
		}),
		"plan.stop": run(func(ctx context.Context, _ *connection, params protocol.PlanParams) (any, error) {
			return s.engine.StopPlan(ctx, params.Session)
		}),
		"session.send": run(func(ctx context.Context, _ *connection, params protocol.SessionSendParams) (any, error) {
			if params.Plan {
				if params.Selection != nil {
					return done(s.engine.SendPlanned(ctx, params.Session, params.Parts, *params.Selection))
				}
				return done(s.engine.SendPlanned(ctx, params.Session, params.Parts))
			}
			if params.Selection != nil {
				return done(s.engine.SendWithBudget(ctx, params.Session, params.Parts, params.ExtendBudget, *params.Selection))
			}
			return done(s.engine.SendWithBudget(ctx, params.Session, params.Parts, params.ExtendBudget))
		}),
		"session.cancel": run(func(_ context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return done(s.engine.Cancel(params.Session))
		}),
		"session.list": run(func(ctx context.Context, _ *connection, params protocol.SessionListParams) (any, error) {
			all, err := s.engine.ListSessions(ctx)
			if err != nil {
				return nil, err
			}
			return slices.DeleteFunc(all, func(info session.Info) bool { return info.Archived != params.Archived }), nil
		}),
		"session.update": run(func(ctx context.Context, _ *connection, params protocol.SessionUpdateParams) (any, error) {
			return done(s.engine.UpdateSession(ctx, params.Session, params.Update))
		}),
		"session.revert": run(func(ctx context.Context, _ *connection, params protocol.SessionRevertParams) (any, error) {
			return done(s.engine.RevertSession(ctx, params.Session, params.Message))
		}),
		"session.unrevert": run(func(ctx context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return done(s.engine.UnrevertSession(ctx, params.Session))
		}),
		"session.compact": run(func(ctx context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return done(s.engine.CompactSession(ctx, params.Session))
		}),
		"session.delete": run(func(ctx context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return done(s.engine.DeleteSession(ctx, params.Session))
		}),
		"session.export": run(func(ctx context.Context, _ *connection, params protocol.SessionCancelParams) (any, error) {
			return s.engine.ExportSession(ctx, params.Session)
		}),
		"session.import": run(func(ctx context.Context, _ *connection, params protocol.SessionImportParams) (any, error) {
			id, err := s.engine.ImportSession(ctx, params.Events)
			return protocol.SessionCreateResult{Session: id}, err
		}),
		"session.search": run(func(ctx context.Context, _ *connection, params protocol.SessionSearchParams) (any, error) {
			return s.engine.SearchSessions(ctx, params.Query, params.Limit)
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
