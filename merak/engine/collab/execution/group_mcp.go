package execution

import (
	"context"
	"errors"
	"os"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
)

type memberMCP struct {
	endpoint *mcp.Endpoint
	mu       sync.Mutex
	report   *task.Report
}

func (domain *Execution) bindWorkerMCP(ctx context.Context, a *worker.Assignment) (*memberMCP, error) {
	card, err := domain.tasks.Get(ctx, a.Claim.Task)
	if err != nil {
		return nil, err
	}
	valid := false
	for _, claim := range card.Claims {
		if claim.ID == a.Claim.ID && claim.Member == a.Claim.Member && claim.Session == a.Session && claim.Status == task.ClaimActive {
			valid = true
		}
	}
	if !valid || card.Group != a.Scope.Group || card.ID != a.Scope.Task {
		return nil, errors.New("MCP requires the active assigned claim")
	}
	binding := new(memberMCP)
	operations := domain.workerTools(*a, func(_ context.Context, report task.Report) error {
		binding.mu.Lock()
		defer binding.mu.Unlock()
		if binding.report != nil {
			return errors.New("claim already submitted a report")
		}
		binding.report = &report
		return nil
	})
	scope := a.Scope
	scope.Session = a.Session
	server := &mcp.Server{Tools: tool.NewPool("worker.group", operations...), Env: tool.Env{Member: a.Claim.Member, Mode: string(a.Mode), Scope: scope, Workdir: a.Workdir, MemoryOwners: domain.roster.MemberMemoryOwners(ctx, a.Workdir, scope, a.Claim.Member)}}
	endpoint, err := mcp.Listen(ctx, server, "worker", string(a.Claim.ID))
	if err != nil {
		return nil, err
	}
	binding.endpoint = endpoint
	a.MCP, err = domain.MCPConfiguration(endpoint, "worker", string(a.Claim.ID))
	if err != nil {
		endpoint.Close()
		return nil, err
	}
	for _, spec := range server.Tools.Specs() {
		a.MCP.Tools = append(a.MCP.Tools, spec.Name)
	}
	a.SandboxProfile.Network.LocalPorts = append(a.SandboxProfile.Network.LocalPorts, endpoint.Port)
	return binding, nil
}

func (domain *Execution) MCPConfiguration(endpoint *mcp.Endpoint, role, scope string) (*worker.MCPConfig, error) {
	command := domain.mcpCommand
	if command == "" {
		var err error
		command, err = os.Executable()
		if err != nil {
			return nil, err
		}
	}
	flag := "--claim"
	if role == "leader" {
		flag = "--thread"
	}
	return &worker.MCPConfig{Command: command, Args: []string{"mcp", flag, scope, "--as", role}, Env: map[string]string{"MERAKCODE_MCP_ADDRESS": endpoint.Address, "MERAKCODE_MCP_TOKEN": endpoint.Token}}, nil
}

type mcpWorkerRun struct {
	worker.Run
	binding *memberMCP
}

func (r *mcpWorkerRun) Wait(ctx context.Context) (task.Report, error) {
	report, err := r.Run.Wait(ctx)
	if ctx.Err() != nil {
		return report, err
	}
	r.binding.endpoint.Close()
	r.binding.mu.Lock()
	defer r.binding.mu.Unlock()
	if r.binding.report != nil && err == nil {
		result := *r.binding.report
		result.Usage = report.Usage
		return result, nil
	}
	return report, err
}
