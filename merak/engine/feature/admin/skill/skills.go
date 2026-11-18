// Package skill manages skill sources and installation for engine users.
package skill

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	agentskill "github.com/TongTong313/merakcode/merak/engine/agent/skill"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
)

// Deps supplies the shared objects used to manage skills.
type Deps struct {
	Cache    string
	Registry *registry.Registry
}

// Manager manages skill discovery and installation using the existing registry.
type Manager struct {
	cache    string
	registry *registry.Registry
}

// New creates the skill manager with the engine's shared dependencies.
func New(d Deps) *Manager {
	return &Manager{cache: d.Cache, registry: d.Registry}
}

// SkillList lists the skills that apply to a folder.
func (e *Manager) SkillList(_ context.Context, directory string) (agentskill.Set, error) {
	return e.registry.Skills(e.registry.Directory(directory))
}

// SkillSources returns the default places to install skills from.
func (e *Manager) SkillSources() []string {
	if roots := e.registry.SkillDirectories(); roots != nil {
		return roots.URLs
	}
	return nil
}

func (e *Manager) skillTarget(scope, directory string) (string, error) {
	switch scope {
	case "project", "":
		return filepath.Join(e.registry.Directory(directory), ".merakcode", "skills"), nil
	case "global":
		if roots := e.registry.SkillDirectories(); roots != nil && roots.Global != "" {
			return filepath.Join(roots.Global, "skills"), nil
		}
	}
	return "", errorcode.Coded(errorcode.SessionRequestFailed, errors.New("unknown skill scope"))
}

// SkillDiscover lists what a source offers: an http(s) address with an index.json, or a git repository.
func (e *Manager) SkillDiscover(ctx context.Context, source, token string) ([]Offer, error) {
	if isGit(source) {
		return DiscoverGit(ctx, source, e.skillCache(), token)
	}
	return DiscoverSource(ctx, source)
}

// SkillInstall installs the chosen skills of a source into the project or the user's folder.
func (e *Manager) SkillInstall(ctx context.Context, source, token string, names []string, scope, directory string) ([]string, error) {
	target, err := e.skillTarget(scope, directory)
	if err != nil {
		return nil, err
	}
	if isGit(source) {
		return InstallGit(ctx, source, e.skillCache(), token, names, target)
	}
	return Install(ctx, source, names, target)
}

// SkillUninstall deletes an installed skill from the project or the user's folder.
func (e *Manager) SkillUninstall(_ context.Context, name, scope, directory string) error {
	target, err := e.skillTarget(scope, directory)
	if err != nil {
		return err
	}
	return Uninstall(target, name)
}

func isGit(source string) bool {
	return strings.HasSuffix(source, ".git") || strings.HasPrefix(source, "git@") || strings.HasPrefix(source, "git://") || strings.HasPrefix(source, "ssh://") || strings.HasPrefix(source, "file://")
}

func (e *Manager) skillCache() string {
	return e.cache
}
