package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/roster"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type workspaceSetup struct {
	Workspace event.ID `json:"workspace"`
	Claim     event.ID `json:"claim"`
	Success   bool     `json:"success"`
	Log       event.ID `json:"log,omitempty"`
	Code      string   `json:"code,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
}

func init() { event.Register[workspaceSetup]("workspace.setup") }

type setupOutput struct {
	mu sync.Mutex
	bytes.Buffer
	truncated bool
}

func (b *setupOutput) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := max(0, 65536-b.Len())
	_, _ = b.Buffer.Write(data[:min(remaining, len(data))])
	b.truncated = b.truncated || len(data) > remaining
	return len(data), nil
}

func (domain *Execution) SetupWorkspace(ctx context.Context, p definition.Agent, a worker.Assignment, ws workspace.Workspace, command []string) error {
	if len(command) == 0 || ws.Kind != workspace.KindWorktree && ws.Kind != workspace.KindFolder {
		return nil
	}
	key := ws.SetupID
	if key == "" {
		key = ws.ID
	}
	doc, err := domain.core.Store.Fetch(ctx, "workspace-setup", string(key))
	if err == nil {
		var prior workspaceSetup
		if json.Unmarshal(doc.Body, &prior) == nil && prior.Success {
			return nil
		}
		if prior.Claim == ws.Claim {
			return errors.New("MRK-5011")
		}
	}
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	result := workspaceSetup{Workspace: ws.ID, Claim: ws.Claim}
	body, _ := json.Marshal(result)
	if err := domain.core.Store.Put(ctx, store.Doc{Kind: "workspace-setup", Key: string(key), Rev: doc.Rev, Body: body}); err != nil {
		return err
	}
	configuration, err := domain.MemberSandboxProfile(ctx, ws.Directory, sandbox.Profile{EnvAllow: []string{"PATH"}})
	if err != nil {
		return err
	}
	configuration, err = DenyProductState(configuration)
	if err != nil {
		return err
	}
	configuration.Network, err = domain.workerNetworkPolicy(ctx, p, a)
	if err != nil {
		return err
	}
	launcher := &sandbox.Launcher{Disabled: p.Mode == permission.ModeTakeover, StateDir: domain.sandboxStateDir, MemberName: p.Name, Unavailable: func(context.Context, sandbox.Status) error { return nil }}
	defer launcher.Close()
	a.SandboxProfile = configuration
	domain.connectSandboxNetwork(launcher, p, a)
	output := new(setupOutput)
	operation := roster.GroupTool{Definition: tool.Spec{Name: "workspace_setup", Effect: tool.EffectExec, Description: "Run the group's installation command in this new claim workspace."}, RunFunc: func(ctx context.Context, _ tool.Call) (any, error) {
		cmd, err := launcher.Command(ctx, configuration, command[0], command[1:]...)
		if err != nil {
			return nil, err
		}
		cmd.Dir = ws.Directory
		cmd.Stdout, cmd.Stderr = output, output
		if err := launcher.Start(cmd, configuration); err != nil {
			return nil, err
		}
		return nil, launcher.Wait(cmd)
	}}
	input, _ := json.Marshal(map[string]any{"command": strings.Join(command, " "), "args": command})
	scope := a.Scope
	scope.Session = ""
	response, runErr := domain.gate.Wrap(operation).Run(ctx, tool.Call{ID: string(domain.core.NewID()), Name: "workspace_setup", Input: input, Env: tool.Env{Member: ws.Member, Mode: string(p.Mode), Scope: scope, Workdir: ws.Directory, Sandbox: launcher, SandboxProfile: configuration}})
	result.Success = runErr == nil && !response.IsError
	result.Log, result.Truncated = domain.core.NewID(), output.truncated
	if !result.Success {
		result.Code = "MRK-5011"
	}
	ending := context.WithoutCancel(ctx)
	if err := domain.core.Store.Put(ending, store.Doc{Kind: "blob", Key: string(result.Log), Body: append([]byte(nil), output.Bytes()...), Meta: map[string]string{"group": string(ws.Group), "task": string(ws.Task), "title": "Workspace setup output"}}); err != nil {
		return err
	}
	doc, err = domain.core.Store.Fetch(ending, "workspace-setup", string(key))
	if err != nil {
		return err
	}
	doc.Body, _ = json.Marshal(result)
	if err := domain.core.Store.Put(ending, doc); err != nil {
		return err
	}
	fact, err := domain.core.Bus.Publish(ending, event.Event{Stream: event.Stream("group:" + ws.Group), Scope: a.Scope, Type: "workspace.setup", Actor: event.Actor{Kind: event.ActorAgent, ID: ws.Member}, Payload: doc.Body})
	if err != nil {
		return err
	}
	if !result.Success {
		state, err := domain.groups.Get(ending, ws.Group)
		if err == nil {
			var to []event.ID
			for _, member := range state.Members {
				if member.Can(group.RoleOwner) {
					to = append(to, member.ID)
				}
			}
			body, _ := json.Marshal(group.Notice{Kind: "blocked", Text: "MRK-5011", To: to})
			_, _ = domain.core.Bus.Publish(ending, event.Event{Stream: fact.Stream, Scope: fact.Scope, Type: group.NoticeSent, Actor: fact.Actor, Cause: fact.ID, Payload: body})
		}
		return errors.New("MRK-5011")
	}
	return nil
}
