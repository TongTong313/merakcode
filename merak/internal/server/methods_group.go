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
		"profile.list": run(func(ctx context.Context, c *connection, _ protocol.ProfileListParams) (any, error) {
			return s.engine.ListProfiles(ctx, c.human)
		}),
		"profile.save": run(func(ctx context.Context, c *connection, params protocol.ProfileSaveParams) (any, error) {
			return s.engine.SaveProfile(ctx, c.human, params.Profile)
		}),
		"profile.delete": run(func(ctx context.Context, c *connection, params protocol.ProfileDeleteParams) (any, error) {
			return done(s.engine.DeleteProfile(ctx, c.human, params.Profile))
		}),
		"member.register": run(func(ctx context.Context, c *connection, params protocol.MemberRegisterParams) (any, error) {
			return s.engine.RegisterMember(ctx, params.Group, c.human, params.Member)
		}),
		"member.test": run(func(ctx context.Context, c *connection, params protocol.ProfileSaveParams) (any, error) {
			return s.engine.TestMember(ctx, c.human, params.Profile)
		}),
		"member.catalog": run(func(ctx context.Context, _ *connection, _ struct{}) (any, error) {
			return worker.Catalog(ctx), nil
		}),
		"member.remove":      removeMember,
		"group.removeMember": removeMember,
		"group.create": run(func(ctx context.Context, _ *connection, params protocol.GroupCreateParams) (any, error) {
			return s.engine.CreateGroup(ctx, params.Group, params.Members, params.Profiles)
		}),
		"group.addMember": run(func(ctx context.Context, c *connection, params protocol.GroupAddMemberParams) (any, error) {
			return s.engine.AddGroupMember(ctx, params.Group, c.human, params.Member, params.Profile)
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
