package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) groupMethods() map[string]handler {
	removeMember := run(func(ctx context.Context, c *connection, params protocol.GroupRemoveMemberParams) (any, error) {
		return done(s.engine.Tasks.RemoveMember(ctx, params.Group, c.human, params.Member))
	})
	return map[string]handler{
		"agent.list": run(func(ctx context.Context, c *connection, _ protocol.AgentListParams) (any, error) {
			return s.engine.ListAgents(ctx, c.human)
		}),
		"agent.save": run(func(ctx context.Context, c *connection, params protocol.AgentSaveParams) (any, error) {
			return s.engine.SaveAgent(ctx, c.human, params.Agent)
		}),
		"agent.delete": run(func(ctx context.Context, c *connection, params protocol.AgentDeleteParams) (any, error) {
			return done(s.engine.DeleteAgent(ctx, c.human, params.Agent))
		}),
		"agent.test": run(func(ctx context.Context, c *connection, params protocol.AgentSaveParams) (any, error) {
			return s.engine.TestAgent(ctx, c.human, params.Agent)
		}),
		"agent.catalog": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return worker.Catalog(ctx), nil
		}),
		"group.removeMember": removeMember,
		"group.create": run(func(ctx context.Context, _ *connection, params protocol.GroupCreateParams) (any, error) {
			return s.engine.CreateGroup(ctx, params.Group, params.Members)
		}),
		"group.addMember": run(func(ctx context.Context, c *connection, params protocol.GroupAddMemberParams) (any, error) {
			return s.engine.AddGroupMember(ctx, params.Group, c.human, params.Member)
		}),
		"group.update": run(func(ctx context.Context, c *connection, params protocol.GroupUpdateParams) (any, error) {
			return s.engine.UpdateGroup(ctx, params.Group, c.human, params.Update)
		}),
		"group.pause": run(func(ctx context.Context, c *connection, params protocol.GroupControlParams) (any, error) {
			return done(s.engine.SetGroupPaused(ctx, params.Group, c.human, params.Thread, true))
		}),
		"group.resume": run(func(ctx context.Context, c *connection, params protocol.GroupControlParams) (any, error) {
			return done(s.engine.SetGroupPaused(ctx, params.Group, c.human, params.Thread, false))
		}),
		"group.state": run(func(ctx context.Context, _ *connection, params protocol.GroupIDParams) (any, error) {
			return s.engine.GroupState(ctx, params.Group)
		}),
		"group.say": run(func(ctx context.Context, c *connection, params protocol.GroupSayParams) (any, error) {
			return s.engine.SayGroup(ctx, params.Group, params.Task, c.human, params.Message)
		}),
		"doc.list": run(func(ctx context.Context, _ *connection, params protocol.GroupIDParams) (any, error) {
			return s.engine.ListGroupDocuments(ctx, params.Group)
		}),
		"doc.read": run(func(ctx context.Context, _ *connection, params protocol.DocReadParams) (any, error) {
			return s.engine.ReadGroupDocument(ctx, params.Group, params.Key)
		}),
		"doc.write": run(func(ctx context.Context, c *connection, params protocol.DocWriteParams) (any, error) {
			return s.engine.WriteGroupDocument(ctx, event.Actor{Kind: event.ActorHuman, ID: c.human}, params.Document)
		}),
	}
}
