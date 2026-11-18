package conversation

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Manager) Has(id event.ID) bool {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	return domain.sessions[id] != nil
}

func (domain *Manager) Barrier() {
	domain.mu.Lock()
	domain.mu.Unlock()
}

func (domain *Manager) Checkpoint(ctx context.Context) error {
	domain.mu.Lock()
	defer domain.mu.Unlock()
	for _, c := range domain.sessions {
		if err := domain.manager.Reconcile(ctx, c.State); err != nil {
			return err
		}
		if err := domain.manager.Snapshot(ctx, c.State); err != nil {
			return err
		}
	}
	return nil
}

// LoadSession loads the existing session state during engine startup recovery.
func (domain *Manager) LoadSession(ctx context.Context, id event.ID) (*session.State, error) {
	return domain.manager.Load(ctx, id)
}

// CheckpointSession reconciles and persists one session during engine startup recovery.
func (domain *Manager) CheckpointSession(ctx context.Context, state *session.State) error {
	if err := domain.manager.Reconcile(ctx, state); err != nil {
		return err
	}
	return domain.manager.Snapshot(ctx, state)
}
