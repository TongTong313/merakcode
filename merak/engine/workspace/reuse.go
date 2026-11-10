package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func validatePooledPath(ws Workspace) error {
	root, err := filepath.EvalSymlinks(filepath.Join(ws.Project, ".merak", "worktrees"))
	if err != nil {
		return err
	}
	path, err := filepath.EvalSymlinks(ws.Directory)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." || !filepath.IsLocal(rel) || strings.ContainsAny(rel, "/\\") {
		return errors.New("worktree pool path escapes its managed directory")
	}
	project, err := filepath.EvalSymlinks(ws.Project)
	if err != nil {
		return err
	}
	if root != filepath.Join(project, ".merak", "worktrees") {
		return errors.New("worktree pool root is redirected")
	}
	return nil
}

func (m *Manager) pooled(ctx context.Context, project string) ([]Workspace, error) {
	docs, err := m.store.List(ctx, "workspace", "")
	if err != nil {
		return nil, err
	}
	var result []Workspace
	for _, doc := range docs {
		ws, err := m.Get(ctx, event.ID(doc.Key))
		if err != nil {
			return nil, err
		}
		if ws.Project != project || !ws.Pooled || !ws.Released || ws.Active {
			continue
		}
		if _, err := os.Stat(ws.Directory); os.IsNotExist(err) {
			ws.Pooled = false
			if err := m.save(ctx, ws); err != nil {
				return nil, err
			}
			continue
		}
		result = append(result, ws)
	}
	return result, nil
}

func (m *Manager) pooledCount(ctx context.Context, project string) (int, error) {
	items, err := m.pooled(ctx, project)
	return len(items), err
}
func (m *Manager) reusable(ctx context.Context, project string) (Workspace, error) {
	items, err := m.pooled(ctx, project)
	if err != nil || len(items) == 0 {
		return Workspace{}, err
	}
	return items[0], nil
}
