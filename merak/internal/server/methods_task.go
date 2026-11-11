package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) taskMethods() map[string]handler {
	return map[string]handler{
		"task.create": run(func(ctx context.Context, c *connection, params protocol.TaskCreateParams) (any, error) {
			card := task.Card{Group: params.Group, Project: params.Project, Title: params.Title, Description: params.Description, Acceptance: params.Acceptance, Areas: params.Areas, Review: params.Review, Priority: params.Priority, Workspace: params.Workspace, Inputs: params.Inputs, Budget: params.Budget, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: c.human}}
			if params.Member != "" {
				return s.engine.CreateAssignedTask(ctx, card, params.Member)
			}
			return s.engine.CreateTask(ctx, card)
		}),
		"task.list": run(func(ctx context.Context, _ *connection, params protocol.TaskListParams) (any, error) {
			return s.engine.ListTasks(ctx, task.Filter{Project: params.Project, Archived: params.Archived})
		}),
		"task.archive": run(func(ctx context.Context, c *connection, params protocol.TaskArchiveParams) (any, error) {
			return s.engine.ArchiveTasks(ctx, params.Tasks, params.Archived, event.Actor{Kind: event.ActorHuman, ID: c.human})
		}),
		"task.assign": run(func(ctx context.Context, c *connection, params protocol.TaskAssignParams) (any, error) {
			return s.engine.AssignTask(ctx, params.Task, c.human, params.Member, params.Role, params.Scope)
		}),
		"task.review": run(func(ctx context.Context, c *connection, params protocol.TaskReviewParams) (any, error) {
			return done(s.engine.ReviewTask(ctx, params.Task, c.human, params.Decision, params.Feedback))
		}),
		"task.update": run(func(ctx context.Context, c *connection, params protocol.TaskUpdateParams) (any, error) {
			if err := s.engine.UpdateTask(ctx, params.Task, params.Update, event.Actor{Kind: event.ActorHuman, ID: c.human}); err != nil {
				return nil, err
			}
			return s.engine.Tasks.Get(ctx, params.Task)
		}),
		"task.cancel": run(func(ctx context.Context, c *connection, params protocol.TaskCancelParams) (any, error) {
			if err := s.engine.Tasks.SetPhase(ctx, params.Task, task.PhaseCancelled, event.Actor{Kind: event.ActorHuman, ID: c.human}); err != nil {
				return nil, err
			}
			return s.engine.Tasks.Get(ctx, params.Task)
		}),
	}
}
