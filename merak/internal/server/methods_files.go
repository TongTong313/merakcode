package server

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) fileMethods() map[string]handler {
	return map[string]handler{
		"file.read": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.ReadFile(ctx, params.Directory, params.Path)
		}),
		"file.list": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.ListFiles(ctx, params.Directory, params.Path)
		}),
		"repo.status": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.RepoStatus(ctx, params.Directory)
		}),
		"repo.branches": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.RepoBranches(ctx, params.Directory)
		}),
		"repo.diff": run(func(ctx context.Context, _ *connection, params protocol.RepoDiffParams) (any, error) {
			return s.engine.RepoDiff(ctx, params.Directory, params.Base, params.Session)
		}),
		"repo.checkout": run(func(ctx context.Context, _ *connection, params protocol.RepoCheckoutParams) (any, error) {
			return done(s.engine.RepoCheckout(ctx, params.Directory, params.Branch))
		}),
		"repo.commit": run(func(ctx context.Context, _ *connection, params protocol.RepoCommitParams) (any, error) {
			commit, err := s.engine.RepoCommit(ctx, params.Directory, params.Message, params.Paths)
			return protocol.RepoCommitResult{Commit: commit}, err
		}),
		"repo.push": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return done(s.engine.RepoPush(ctx, params.Directory))
		}),
		"repo.commitMessage": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			message, err := s.engine.RepoCommitMessage(ctx, params.Directory)
			return protocol.RepoCommitMessageResult{Message: message}, err
		}),
		"worktree.create": run(func(ctx context.Context, _ *connection, params protocol.WorktreeCreateParams) (any, error) {
			return s.engine.CreateWorktree(ctx, params.Directory, params.Key, params.Branch)
		}),
		"worktree.list": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.ListWorktrees(ctx, params.Directory)
		}),
		"worktree.merge": run(func(ctx context.Context, _ *connection, params protocol.WorktreePathParams) (any, error) {
			return done(s.engine.MergeWorktree(ctx, params.Path))
		}),
		"worktree.remove": run(func(ctx context.Context, _ *connection, params protocol.WorktreePathParams) (any, error) {
			return done(s.engine.RemoveWorktree(ctx, params.Path))
		}),
		"file.status": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.FileStatus(ctx, params.Directory, params.Path)
		}),
		"file.identity": run(func(ctx context.Context, _ *connection, params protocol.FileParams) (any, error) {
			return s.engine.FileIdentity(ctx, params.Directory, params.Path)
		}),
		"file.find": run(func(ctx context.Context, _ *connection, params protocol.FileFindParams) (any, error) {
			return s.engine.FindFiles(ctx, params.Directory, params.Query, params.Limit)
		}),
		"terminal.list": run(func(_ context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.Terminals.List(params.Directory), nil
		}),
		"terminal.create": run(func(ctx context.Context, _ *connection, params terminal.CreateOptions) (any, error) {
			return s.engine.Terminals.Create(ctx, params)
		}),
		"terminal.get": run(func(_ context.Context, _ *connection, params protocol.TerminalIDParams) (any, error) {
			return s.engine.Terminals.Get(params.ID)
		}),
		"terminal.remove": run(func(ctx context.Context, _ *connection, params protocol.TerminalIDParams) (any, error) {
			return done(s.engine.Terminals.Remove(ctx, params.ID))
		}),
		"terminal.update": run(func(ctx context.Context, _ *connection, params protocol.TerminalUpdateParams) (any, error) {
			return s.engine.Terminals.Update(ctx, params.ID, params.UpdateOptions)
		}),
		"blob.read": run(func(ctx context.Context, _ *connection, params protocol.BlobReadParams) (any, error) {
			data, total, err := s.engine.ReadBlob(ctx, params.Ref, params.Offset, params.Limit)
			return protocol.BlobReadResult{Data: data, Total: total, Offset: params.Offset}, err
		}),
	}
}
