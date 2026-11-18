package execution

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// TestAgent checks an actual runner exchange without exposing project files as its working directory.
func (domain *Execution) TestAgent(ctx context.Context, human event.ID, p definition.Agent) (definition.Caps, error) {
	if human == "" {
		return definition.Caps{}, errors.New("profile owner is required")
	}
	if err := registry.ValidateAgent(p); err != nil {
		return definition.Caps{}, err
	}
	if p.ID != "" {
		profiles, err := domain.registry.ListAgents(ctx, human)
		if err != nil {
			return definition.Caps{}, err
		}
		owned := false
		for _, item := range profiles {
			owned = owned || item.ID == p.ID
		}
		if !owned {
			return definition.Caps{}, errors.New("profile is not owned by this human")
		}
	}
	p, err := domain.registry.WithAgentSecrets(ctx, p)
	if err != nil {
		return definition.Caps{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if domain.temporary == "" {
		return definition.Caps{}, errors.New("temporary directory is required")
	}
	dir, err := os.MkdirTemp(domain.temporary, "merak-member-test-")
	if err != nil {
		return definition.Caps{}, err
	}
	defer os.RemoveAll(dir)
	p.ToolPool = "worker.readonly"
	if p.Product != nil && (p.Product.Kind == definition.KindCommand || p.Product.Kind == definition.KindACP) {
		p.ToolPool = "worker.default"
	}
	run, err := domain.StartWorker(ctx, p, worker.Assignment{Session: domain.core.NewID(), Claim: task.Claim{ID: domain.core.NewID(), Member: domain.core.NewID()}, Workdir: dir, Packet: "This is a connection check. Reply with OK only. Do not read or modify files and do not use tools."})
	if err != nil {
		return definition.Caps{}, err
	}
	report, err := run.Wait(ctx)
	if err != nil {
		_ = run.Cancel(context.Background())
		_, _ = run.Wait(context.Background())
		return definition.Caps{}, err
	}
	if report.Verdict != task.VerdictDone {
		return definition.Caps{}, errors.New("member connection check failed")
	}
	return domain.runnerFor(p, nil).Caps(), nil
}
