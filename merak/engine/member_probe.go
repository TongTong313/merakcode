package engine

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

// TestAgent checks an actual runner exchange without exposing project files as its working directory.
func (e *Engine) TestAgent(ctx context.Context, human event.ID, p agent.Agent) (worker.Caps, error) {
	if human == "" {
		return worker.Caps{}, errors.New("profile owner is required")
	}
	if err := validateAgent(p); err != nil {
		return worker.Caps{}, err
	}
	if p.ID != "" {
		profiles, err := e.ListAgents(ctx, human)
		if err != nil {
			return worker.Caps{}, err
		}
		owned := false
		for _, item := range profiles {
			owned = owned || item.ID == p.ID
		}
		if !owned {
			return worker.Caps{}, errors.New("profile is not owned by this human")
		}
	}
	p, err := e.withAgentSecrets(ctx, p)
	if err != nil {
		return worker.Caps{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp("", "merak-member-test-")
	if err != nil {
		return worker.Caps{}, err
	}
	defer os.RemoveAll(dir)
	p.Role, p.ToolPool = agent.Worker, "worker.readonly"
	if p.Product != nil && (p.Product.Kind == worker.KindCommand || p.Product.Kind == worker.KindACP) {
		p.ToolPool = "worker.default"
	}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: e.newID(), Claim: task.Claim{ID: e.newID(), Member: e.newID()}, Workdir: dir, Packet: "This is a connection check. Reply with OK only. Do not read or modify files and do not use tools."})
	if err != nil {
		return worker.Caps{}, err
	}
	report, err := run.Wait(ctx)
	if err != nil {
		_ = run.Cancel(context.Background())
		_, _ = run.Wait(context.Background())
		return worker.Caps{}, err
	}
	if report.Verdict != task.VerdictDone {
		return worker.Caps{}, errors.New("member connection check failed")
	}
	return e.runnerFor(p, nil).Caps(), nil
}
