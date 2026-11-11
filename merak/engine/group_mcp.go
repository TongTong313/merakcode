package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func (e *Engine) leaderMCPServer(g *groupRun, thread *leader.Thread, finish func(string)) *mcp.Server {
	return &mcp.Server{Tools: tool.NewPool("leader.group", e.leaderTools(g, thread, finish)...), Env: tool.Env{Member: thread.Leader, Scope: thread.Session.Scope, Workdir: g.configuration().Project.Directory, MemoryOwners: e.memberMemoryOwners(e.ctx, g.configuration().Project.Directory, thread.Session.Scope, thread.Leader)}}
}

func (e *Engine) workerTools(a worker.Assignment, submit func(context.Context, task.Report) error) []tool.Tool {
	return []tool.Tool{
		e.groupLookup(a.Scope.Group),
		e.readGroupDoc(a.Scope.Group),
		e.gate.Wrap(tool.Remember{Memory: e.notes}),
		e.gate.Wrap(tool.Recall{Memory: e.notes}),
		e.askLeaderTool(a),
		tool.AskUser{Bus: e.Bus, Ask: e.askQuestion},
		tool.SubmitReport{Claim: a.Claim.ID, Submit: submit},
		tool.ClaimTask{Claim: func(ctx context.Context, id event.ID, scope []string) (task.Claim, error) {
			return e.Tasks.Claim(ctx, id, a.Scope.Group, a.Claim.Member, scope)
		}},
		tool.ReportProgress{Report: func(ctx context.Context, summary string) error {
			body, _ := json.Marshal(task.Progress{Claim: a.Claim.ID, Summary: summary})
			_, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope, Type: task.Progressed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
			return err
		}},
	}
}

type memberMCP struct {
	endpoint *mcp.Endpoint
	mu       sync.Mutex
	report   *task.Report
}

func (e *Engine) bindWorkerMCP(ctx context.Context, a *worker.Assignment) (*memberMCP, error) {
	card, err := e.Tasks.Get(ctx, a.Claim.Task)
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
	operations := e.workerTools(*a, func(_ context.Context, report task.Report) error {
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
	server := &mcp.Server{Tools: tool.NewPool("worker.group", operations...), Env: tool.Env{Member: a.Claim.Member, Mode: string(a.Mode), Scope: scope, Workdir: a.Workdir, MemoryOwners: e.memberMemoryOwners(ctx, a.Workdir, scope, a.Claim.Member)}}
	endpoint, err := mcp.Listen(ctx, server, "worker", string(a.Claim.ID))
	if err != nil {
		return nil, err
	}
	binding.endpoint = endpoint
	a.MCP, err = e.mcpConfiguration(endpoint, "worker", string(a.Claim.ID))
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

func (e *Engine) mcpConfiguration(endpoint *mcp.Endpoint, role, scope string) (*worker.MCPConfig, error) {
	command := e.mcpCommand
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
