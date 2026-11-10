package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

// ForClaim waits for incompatible project leases before creating the workspace.
func (m *Manager) ForClaim(ctx context.Context, project string, claim task.Claim, card task.Card) (Workspace, error) {
	if !safeID(card.ID) || !safeID(claim.Member) || claim.Task != card.ID || claim.ID == "" {
		return Workspace{}, errors.New("invalid workspace claim")
	}
	if card.Workspace != KindWorktree && card.Workspace != KindFolder && card.Workspace != KindInplace && card.Workspace != KindNone {
		return Workspace{}, errors.New("unsupported workspace kind")
	}
	project, err := filepath.Abs(project)
	if err != nil {
		return Workspace{}, err
	}
	project, err = filepath.EvalSymlinks(project)
	if err != nil {
		return Workspace{}, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(m.ctx, cancel)
	defer stop()
	for {
		if err := ctx.Err(); err != nil {
			return Workspace{}, err
		}
		m.mu.Lock()
		previous, err := m.previous(ctx, claim.ID)
		if err != nil {
			m.mu.Unlock()
			return Workspace{}, err
		}
		if previous.ID != "" && (previous.Released || previous.Project != project || previous.Kind != card.Workspace || previous.Member != claim.Member || previous.Task != card.ID) {
			m.mu.Unlock()
			return Workspace{}, errors.New("claim workspace cannot be replaced")
		}
		available, err := m.available(ctx, project, card.Workspace, previous.ID)
		if err != nil {
			m.mu.Unlock()
			return Workspace{}, err
		}
		if available {
			if previous.ID != "" {
				previous.Active = true
				err := m.save(ctx, previous)
				if err == nil {
					err = m.emit(ctx, previous, Resumed, previous)
				}
				m.mu.Unlock()
				return previous, err
			}
			ws, err := m.create(ctx, project, claim, card)
			m.mu.Unlock()
			return ws, err
		}
		changed := m.changed
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return Workspace{}, ctx.Err()
		case <-changed:
		}
	}
}

func (m *Manager) available(ctx context.Context, project string, kind Kind, own event.ID) (bool, error) {
	if kind != KindInplace && kind != KindFolder {
		return true, nil
	}
	docs, err := m.store.List(ctx, "workspace", "")
	if err != nil {
		return false, err
	}
	for _, doc := range docs {
		value, err := m.store.Fetch(ctx, doc.Kind, doc.Key)
		if err != nil {
			return false, err
		}
		var ws Workspace
		if err := json.Unmarshal(value.Body, &ws); err != nil {
			return false, err
		}
		if ws.ID == own || ws.Released || !ws.Active || ws.Kind != KindInplace && ws.Kind != KindFolder {
			continue
		}
		same := project == ws.Project
		if !same {
			current, currentErr := os.Stat(project)
			other, otherErr := os.Stat(ws.Project)
			same = currentErr == nil && otherErr == nil && os.SameFile(current, other)
		}
		if same && (kind == KindInplace || ws.Kind == KindInplace) {
			return false, nil
		}
	}
	return true, nil
}

func (m *Manager) previous(ctx context.Context, claim event.ID) (Workspace, error) {
	docs, err := m.store.List(ctx, "workspace", "")
	if err != nil {
		return Workspace{}, err
	}
	for _, doc := range docs {
		ws, err := m.Get(ctx, event.ID(doc.Key))
		if err != nil {
			return Workspace{}, err
		}
		if ws.Claim == claim {
			return ws, nil
		}
	}
	return Workspace{}, nil
}

// EndClaim releases execution leases while retaining files for review and rework.
func (m *Manager) EndClaim(ctx context.Context, workspace Workspace) error {
	return m.endLease(ctx, workspace.ID, Idle)
}

// ReleaseLease repairs a stale execution lease without deleting review resources.
func (m *Manager) ReleaseLease(ctx context.Context, id event.ID) error {
	return m.endLease(ctx, id, Released)
}

func (m *Manager) endLease(ctx context.Context, id event.ID, kind event.Type) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	ws, err := m.Get(ctx, id)
	if err != nil {
		return err
	}
	if !ws.Active {
		return nil
	}
	ws.Active = false
	if err := m.save(ctx, ws); err != nil {
		return err
	}
	if err := m.emit(ctx, ws, kind, ws); err != nil {
		return err
	}
	close(m.changed)
	m.changed = make(chan struct{})
	return nil
}

func (m *Manager) create(ctx context.Context, project string, claim task.Claim, card task.Card) (Workspace, error) {
	switch card.Workspace {
	case KindWorktree:
		return m.forWorktree(ctx, project, claim, card)
	case KindFolder:
		return m.forFolder(ctx, project, claim, card)
	default:
		ws := Workspace{ID: m.newID(), Active: true, Kind: card.Workspace, Group: card.Group, Task: card.ID, Claim: claim.ID, Member: claim.Member, Project: project, Directory: project}
		if err := m.save(ctx, ws); err != nil {
			return Workspace{}, err
		}
		return ws, m.emit(ctx, ws, Created, ws)
	}
}
