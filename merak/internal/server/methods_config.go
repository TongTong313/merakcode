package server

import (
	"context"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/rules"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func (s *Server) configMethods() map[string]handler {
	return map[string]handler{
		"config.get": run(func(_ context.Context, _ *connection, _ struct{}) (any, error) {
			return s.configuration(), nil
		}),
		"config.set": run(func(_ context.Context, _ *connection, patch config.Patch) (any, error) {
			return s.configure(patch)
		}),
		"command.list": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.engine.CommandList(ctx, params.Directory)
		}),
		"skill.list": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			set, err := s.engine.SkillList(ctx, params.Directory)
			sources := s.engine.SkillSources()
			if sources == nil {
				sources = []string{}
			}
			return protocol.SkillListResult{Skills: set.Skills, Problems: set.Problems, Sources: sources}, err
		}),
		"skill.discover": run(func(ctx context.Context, _ *connection, params protocol.SkillDiscoverParams) (any, error) {
			return s.engine.SkillDiscover(ctx, params.Source, params.Token)
		}),
		"skill.install": run(func(ctx context.Context, _ *connection, params protocol.SkillInstallParams) (any, error) {
			installed, err := s.engine.SkillInstall(ctx, params.Source, params.Token, params.Names, params.Scope, params.Directory)
			return protocol.SkillInstallResult{Installed: installed}, err
		}),
		"skill.uninstall": run(func(ctx context.Context, _ *connection, params protocol.SkillUninstallParams) (any, error) {
			return done(s.engine.SkillUninstall(ctx, params.Name, params.Scope, params.Directory))
		}),
		"rules.read": run(func(ctx context.Context, _ *connection, params protocol.DirectoryParams) (any, error) {
			return s.readRules(ctx, params.Directory)
		}),
		"rules.change": run(func(ctx context.Context, _ *connection, params protocol.RulesChangeParams) (any, error) {
			return done(s.changeRules(ctx, params))
		}),
		"memory.list": run(func(ctx context.Context, _ *connection, params protocol.MemoryListParams) (any, error) {
			return s.engine.MemoryList(ctx, params.Directory, params.Scope)
		}),
		"memory.read": run(func(ctx context.Context, _ *connection, params protocol.MemoryNoteParams) (any, error) {
			return s.engine.MemoryRead(ctx, params.ID)
		}),
		"memory.delete": run(func(ctx context.Context, _ *connection, params protocol.MemoryNoteParams) (any, error) {
			return done(s.engine.MemoryDelete(ctx, params.ID))
		}),
		"mcp.status": run(func(ctx context.Context, _ *connection, params protocol.MCPStatusParams) (any, error) {
			return s.engine.MCPStatus(ctx, params.Directory)
		}),
		"mcp.authenticate": run(func(ctx context.Context, _ *connection, params protocol.MCPServerParams) (any, error) {
			address, err := s.engine.MCPAuthenticate(ctx, params.Server)
			return protocol.MCPAuthenticateResult{URL: address}, err
		}),
		"mcp.logout": run(func(ctx context.Context, _ *connection, params protocol.MCPServerParams) (any, error) {
			return done(s.engine.MCPLogout(ctx, params.Server))
		}),
		"model.list": run(func(_ context.Context, _ *connection, params protocol.ModelListParams) (any, error) {
			for _, o := range params.Overrides {
				if o.Provider == "" || o.ID == "" || o.Window != nil && *o.Window <= 0 || o.MaxOutput != nil && *o.MaxOutput <= 0 {
					return nil, errors.New("invalid model override")
				}
			}
			return s.engine.ModelCatalog(params.Overrides...), nil
		}),
		"model.discover": run(func(ctx context.Context, _ *connection, params protocol.ModelDiscoverParams) (any, error) {
			return discoverModels(ctx, params.Provider)
		}),
		"model.refresh": run(func(ctx context.Context, _ *connection, params protocol.ModelRefreshParams) (any, error) {
			if err := s.engine.RefreshModels(ctx, params.Provider); err != nil {
				return nil, err
			}
			return s.engine.ModelCatalog(), nil
		}),
		"diagnostics.bundle": run(func(ctx context.Context, _ *connection, params protocol.DiagnosticsParams) (any, error) {
			return s.diagnostics(ctx, params)
		}),
	}
}

func (s *Server) readRules(ctx context.Context, directory string) (protocol.RulesReadResult, error) {
	directory = s.engine.Directory(directory)
	set, err := rules.Load(ctx, directory)
	if err != nil {
		return protocol.RulesReadResult{}, err
	}
	result := protocol.RulesReadResult{Personal: s.configuration().Rules.User, Instructions: set.Instructions, Rules: []protocol.RuleView{}}
	if result.Personal == nil {
		result.Personal = []string{}
	}
	for _, rule := range set.Rules {
		result.Rules = append(result.Rules, protocol.RuleView{Name: rule.Name, Path: rule.Path, Description: rule.Description, Globs: rule.Globs, Kind: rule.Kind(), Truncated: rule.Truncated, Body: rule.Body})
	}
	return result, nil
}

func (s *Server) changeRules(ctx context.Context, params protocol.RulesChangeParams) error {
	if params.File != nil {
		root := s.engine.Directory(params.Directory)
		if params.File.Body == nil {
			if err := rules.DeleteFile(root, params.File.Name); err != nil {
				return err
			}
		} else if _, err := rules.WriteFile(root, params.File.Name, *params.File.Body); err != nil {
			return err
		}
	}
	if params.Personal != nil {
		if _, err := s.configure(config.Patch{Rules: &config.RulesPatch{User: params.Personal}}); err != nil {
			return err
		}
	}
	return ctx.Err()
}
