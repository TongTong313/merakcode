package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/mcp"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type sandboxKey struct {
	session  event.ID
	disabled bool
}

func (e *Engine) SetupSandbox(ctx context.Context) error {
	return sandbox.Initialize(ctx, e.sandboxStateDir)
}

func (e *Engine) MemberSandboxStatus(ctx context.Context, groupID, memberID, sessionID event.ID) (sandbox.Status, error) {
	state, err := e.Groups.Get(ctx, groupID)
	if err != nil {
		return sandbox.Status{}, err
	}
	member, err := e.groupMember(ctx, groupID, memberID)
	if err != nil {
		return sandbox.Status{}, err
	}
	p, err := e.memberProfile(ctx, member)
	if err != nil {
		return sandbox.Status{}, err
	}
	if sessionID != "" {
		saved, err := e.manager.Load(ctx, sessionID)
		if err != nil {
			return sandbox.Status{}, err
		}
		if saved.Scope.Group != groupID || saved.Config.Member != memberID {
			return sandbox.Status{}, errors.New("MRK-6001")
		}
		if p.Product != nil && p.Product.Kind == worker.KindRemote {
			return e.remoteSandboxStatus(ctx, p.Product.Remote, protocol.SandboxStatusParams{Session: sessionID})
		}
		return e.SandboxStatus(ctx, saved.Config.Workdir, saved.Config.Mode, sessionID)
	}
	if p.Product != nil && p.Product.Kind == worker.KindRemote {
		return e.remoteSandboxStatus(ctx, p.Product.Remote, protocol.SandboxStatusParams{Group: p.Product.Remote.Group, Member: p.Product.Remote.Member})
	}
	return e.SandboxStatus(ctx, state.Group.Project.Directory, p.Mode)
}

func (e *Engine) remoteSandboxStatus(ctx context.Context, source *profile.RemoteSource, params protocol.SandboxStatusParams) (sandbox.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	credentials, err := e.remoteCredentials(ctx, source.Connection)
	if err != nil {
		return sandbox.Status{}, err
	}
	client, err := protocol.Connect(ctx, credentials.Endpoint, credentials.Token, protocol.HelloParams{Protocol: protocol.Version})
	if err != nil {
		return sandbox.Status{}, err
	}
	defer client.Close()
	var status sandbox.Status
	err = client.Call(ctx, "sandbox.status", params, &status)
	return status, err
}

func (e *Engine) keepSandbox(session event.ID, launcher *sandbox.Launcher) *sandbox.Launcher {
	e.sandboxMu.Lock()
	defer e.sandboxMu.Unlock()
	key := sandboxKey{session, launcher.Disabled}
	if existing := e.sandboxes[key]; existing != nil {
		return existing
	}
	e.sandboxes[key] = launcher
	launcher.ReclaimAccount = func() (bool, error) { return e.reclaimSandbox(launcher) }
	return launcher
}

func (e *Engine) reclaimSandbox(requester *sandbox.Launcher) (bool, error) {
	e.sandboxMu.Lock()
	var candidates []*sandbox.Launcher
	for _, launcher := range e.sandboxes {
		if launcher != requester {
			candidates = append(candidates, launcher)
		}
	}
	e.sandboxMu.Unlock()
	var oldest *sandbox.Launcher
	var since time.Time
	for _, launcher := range candidates {
		idle := launcher.IdleSince()
		if !idle.IsZero() && (since.IsZero() || idle.Before(since)) {
			oldest, since = launcher, idle
		}
	}
	if oldest == nil {
		return false, nil
	}
	return oldest.Reclaim()
}

func (e *Engine) releaseSandbox(session event.ID) {
	e.sandboxMu.Lock()
	var processes []*mcp.Process
	for id, live := range e.mcpProcesses {
		if session == "" || id == session {
			processes = append(processes, live...)
			delete(e.mcpProcesses, id)
		}
	}
	var launchers []*sandbox.Launcher
	for key, launcher := range e.sandboxes {
		if session == "" || key.session == session {
			launchers = append(launchers, launcher)
			delete(e.sandboxes, key)
		}
	}
	e.sandboxMu.Unlock()
	var failure error
	for _, process := range processes {
		failure = errors.Join(failure, process.Close())
	}
	for _, launcher := range launchers {
		failure = errors.Join(failure, launcher.Close())
	}
	if failure != nil {
		e.sandboxMu.Lock()
		e.sandboxErr = errors.Join(e.sandboxErr, failure)
		e.sandboxMu.Unlock()
	}
}

func (e *Engine) SandboxStatus(ctx context.Context, workdir string, mode permission.Mode, sessions ...event.ID) (sandbox.Status, error) {
	if err := ctx.Err(); err != nil {
		return sandbox.Status{}, err
	}
	if mode != "" && mode != permission.ModeAsk && mode != permission.ModeAuto && mode != permission.ModeTakeover {
		return sandbox.Status{}, errors.New("unknown permission mode")
	}
	launcher := &sandbox.Launcher{StateDir: e.sandboxStateDir, Disabled: mode == permission.ModeTakeover}
	if len(sessions) > 0 && sessions[0] != "" {
		e.sandboxMu.Lock()
		for key, live := range e.sandboxes {
			if key.session == sessions[0] {
				launcher = live
				break
			}
		}
		e.sandboxMu.Unlock()
		state, err := e.SessionSnapshot(ctx, sessions[0])
		if err != nil {
			return sandbox.Status{}, err
		}
		workdir = state.Config.Workdir
		if state.Config.Mode == permission.ModeTakeover {
			launcher = &sandbox.Launcher{Disabled: true}
		}
	}
	if launcher.Disabled {
		return launcher.Status(ctx, sandbox.Profile{}), nil
	}
	if workdir == "" {
		workdir = e.workdir
	}
	p, err := e.memberSandboxProfile(ctx, workdir, sandbox.Profile{})
	if err != nil {
		return sandbox.Status{}, err
	}
	return launcher.Status(ctx, p), nil
}

func (e *Engine) memberSandboxProfile(ctx context.Context, workdir string, p sandbox.Profile) (sandbox.Profile, error) {
	p.EnvAllow = append(append([]string(nil), p.EnvAllow...), "PATH", "GIT_REFLOG_ACTION", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot")
	root, err := resolvedSandboxPath(workdir)
	if err != nil {
		return p, err
	}
	p.WriteAllow = []string{root}
	gitFile, err := os.Stat(filepath.Join(root, ".git"))
	if err != nil && !os.IsNotExist(err) {
		return p, err
	}
	for _, name := range []string{".git/hooks", ".git/config", "merakcode.json", "merakcode.jsonc", ".merakcode"} {
		path := filepath.Join(root, name)
		if gitFile != nil && !gitFile.IsDir() && strings.HasPrefix(name, ".git/") {
			path, err = git.MetadataPath(ctx, root, strings.TrimPrefix(name, ".git/"))
			if err != nil {
				return p, err
			}
		}
		path, err = resolvedSandboxPath(path)
		if err != nil {
			return p, err
		}
		p.Protect = append(p.Protect, path)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p, err
	}
	for _, name := range []string{".ssh", ".aws", ".azure", ".kube", ".gnupg", ".docker", ".config/gcloud", ".config/gh"} {
		path, err := resolvedSandboxPath(filepath.Join(home, name))
		if err != nil {
			return p, err
		}
		p.ReadDeny = append(p.ReadDeny, path)
	}
	if e.dataDir != "" {
		path, err := resolvedSandboxPath(e.dataDir)
		if err != nil {
			return p, err
		}
		p.ReadDeny = append(p.ReadDeny, path)
	}
	return p, nil
}

func resolvedSandboxPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) || filepath.Dir(absolute) == absolute {
		return "", err
	}
	parent, err := resolvedSandboxPath(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}

func denyProductState(configuration sandbox.Profile) (sandbox.Profile, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return configuration, err
	}
	for _, name := range []string{".claude", ".claude.json", ".codex", ".pi", ".config/opencode", ".local/share/opencode"} {
		path, err := resolvedSandboxPath(filepath.Join(home, name))
		if err != nil {
			return configuration, err
		}
		configuration.ReadDeny = append(configuration.ReadDeny, path)
		configuration.TransientReadDeny = append(configuration.TransientReadDeny, path)
	}
	return configuration, nil
}

func (e *Engine) connectSandboxNetwork(launcher *sandbox.Launcher, p profile.Profile, a worker.Assignment) {
	launcher.MemberName = p.Name
	launcher.ApproveNetwork = func(ctx context.Context, host string) (bool, error) { return e.approveWorkerNetwork(ctx, p, a, host) }
	launcher.NetworkDenied = func(ctx context.Context, denial sandbox.NetworkDenial) error {
		return e.recordDeniedNetwork(ctx, p, a, denial)
	}
}

type launchGrant struct {
	Session event.ID
	Member  string
	Project string
}

func (e *Engine) sessionLaunchDecision(key launchGrant) permission.Decision {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.launchGrants[key]
}

func (e *Engine) rememberSessionLaunch(key launchGrant, decision permission.Decision) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.launchGrants == nil {
		e.launchGrants = make(map[launchGrant]permission.Decision)
	}
	e.launchGrants[key] = decision
}

func (e *Engine) approveUnconfinedMember(ctx context.Context, p profile.Profile, a worker.Assignment, status sandbox.Status) error {
	scope := a.Scope
	scope.Session = a.Session
	input, err := json.Marshal(map[string]any{"member": p.Name, "reason": status.Reason, "unconfined": !status.Available, "networkUnenforced": status.Network == "none"})
	if err != nil {
		return err
	}
	call := model.ToolCall{ID: string(e.newID()), Name: "sandbox_launch", Input: input}
	emit := func(kind event.Type, actor event.Actor, cause event.ID, payload any) (event.ID, error) {
		body, err := json.Marshal(payload)
		if err != nil {
			return "", err
		}
		fact, err := e.Bus.Publish(context.WithoutCancel(ctx), event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: kind, Actor: actor, Cause: cause, Payload: body})
		return fact.ID, err
	}
	agent := event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}
	called, err := emit(tool.Called, agent, "", call)
	if err != nil {
		return err
	}
	description := "This member cannot forward approvals. The sandbox is unavailable on this machine. Its operations will be unrestricted after startup."
	if status.Available {
		description = "This member cannot forward approvals. Network restrictions are not enforced; file restrictions remain active."
	}
	request := permission.Request{Member: a.Claim.Member, Kind: "launch", Spec: tool.Spec{Name: call.Name, Effect: tool.EffectExec, Description: description}, Call: tool.Call{ID: call.ID, Name: call.Name, Input: input, Env: tool.Env{Scope: scope, Workdir: a.Workdir}}}
	projectPath, err := e.executionProject(ctx, scope, a.Workdir)
	if err != nil {
		return err
	}
	project, err := resolvedSandboxPath(projectPath)
	if err != nil {
		return err
	}
	member := string(a.Claim.Member)
	_, sourceMember := e.executionSource(scope, a.Claim.Member)
	if sourceMember != "" {
		member = string(sourceMember)
	}
	if member == "" {
		member = string(p.ID)
	}
	settings := e.networkConfiguration()
	reply := permission.Reply{}
	key := launchGrant{Session: a.Session, Member: member, Project: project}
	if member != "" {
		reply.Decision = permission.Decision(settings.UnconfinedDecision(member, project))
		if reply.Decision == "" {
			reply.Decision = e.sessionLaunchDecision(key)
		}
	}
	var askErr error
	if reply.Decision == "" {
		reply, askErr = e.askPermission(ctx, request)
		if askErr == nil && reply.Remember == "always" && member != "" {
			if err := settings.RememberUnconfinedDecision(member, project, string(reply.Decision)); err != nil {
				return err
			}
		}
		if askErr == nil && reply.Remember == "session" && member != "" {
			e.rememberSessionLaunch(key, reply.Decision)
		}
	}
	result := tool.Result{Parts: []model.Part{{Text: "Unrestricted startup approved."}}}
	if askErr != nil || reply.Decision != permission.Allow {
		result = tool.Result{IsError: true, Code: "MRK-5006", MemberName: p.Name, Parts: []model.Part{{Text: "Unrestricted startup denied."}}}
	}
	if _, err := emit(tool.Completed, agent, called, tool.Completion{CallID: call.ID, Name: call.Name, Result: result}); err != nil {
		return err
	}
	if result.IsError {
		return errors.New(result.Code)
	}
	return ctx.Err()
}

func (e *Engine) workerNetworkHosts(ctx context.Context, p profile.Profile, a worker.Assignment) ([]string, error) {
	if a.Scope.Group == "" {
		return append(e.networkConfiguration().AllowedNetworkHosts(), p.Network...), nil
	}
	state, err := e.Groups.Get(ctx, a.Scope.Group)
	if err != nil {
		return nil, err
	}
	for _, member := range state.Members {
		if member.ID != a.Claim.Member {
			continue
		}
		hosts := append([]string(nil), state.Group.Settings.AllowedHosts...)
		for _, host := range p.Network {
			if slices.ContainsFunc(member.Hosts, func(accepted string) bool {
				return strings.EqualFold(strings.TrimSuffix(host, "."), strings.TrimSuffix(accepted, "."))
			}) {
				hosts = append(hosts, host)
			}
		}
		return hosts, nil
	}
	return nil, errors.New("sandbox assignment member is not in the group")
}

func (e *Engine) approveWorkerNetwork(ctx context.Context, p profile.Profile, a worker.Assignment, host string) (bool, error) {
	ctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(e.ctx, cancel)
	defer stop()
	defer cancel()
	hosts, err := e.workerNetworkHosts(ctx, p, a)
	if err != nil {
		return false, err
	}
	if slices.ContainsFunc(hosts, func(known string) bool {
		return strings.EqualFold(strings.TrimSuffix(known, "."), strings.TrimSuffix(host, "."))
	}) {
		return true, nil
	}
	scope := a.Scope
	scope.Session = a.Session
	input, err := json.Marshal(map[string]string{"host": host, "member": p.Name})
	if err != nil {
		return false, err
	}
	call := model.ToolCall{ID: string(e.newID()), Name: "sandbox_network", Input: input}
	request := permission.Request{Member: a.Claim.Member, Kind: "network", Host: host, Spec: tool.Spec{Name: call.Name, Effect: tool.EffectNetwork, Description: "Allow this member to connect to the requested host."}, Call: tool.Call{ID: call.ID, Name: call.Name, Input: input, Env: tool.Env{Scope: scope, Workdir: a.Workdir}}}
	reply, err := e.askPermission(ctx, request)
	if err != nil {
		return false, err
	}
	if reply.Decision == permission.Allow && a.Scope.Group != "" {
		if err := e.Groups.AllowNetworkHost(ctx, a.Scope.Group, reply.Human, host); err != nil {
			return false, err
		}
		if p.Product != nil && slices.ContainsFunc(p.Network, func(value string) bool { return strings.EqualFold(strings.TrimSuffix(value, "."), host) }) {
			if err := e.Groups.AcceptMemberHost(ctx, a.Scope.Group, reply.Human, a.Claim.Member, host); err != nil {
				return false, err
			}
		}
	}
	if reply.Decision == permission.Allow && a.Scope.Group == "" {
		if err := e.networkConfiguration().AllowNetworkHost(host); err != nil {
			return false, err
		}
	}
	return reply.Decision == permission.Allow, nil
}

func (e *Engine) recordDeniedNetwork(ctx context.Context, p profile.Profile, a worker.Assignment, denial sandbox.NetworkDenial) error {
	host := denial.Host
	scope := a.Scope
	scope.Session = a.Session
	input, err := json.Marshal(map[string]string{"host": host, "member": p.Name})
	if err != nil {
		return err
	}
	call := model.ToolCall{ID: string(e.newID()), Name: "sandbox_network", Input: input}
	body, err := json.Marshal(call)
	if err != nil {
		return err
	}
	called, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Called, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
	if err != nil {
		return err
	}
	result := tool.Result{IsError: true, Code: "MRK-5005", DeniedHost: host, MemberName: p.Name, Parts: []model.Part{{Text: "Network destination denied. Review the member profile network hosts."}}}
	if denial.Source != "" {
		result.DeniedSource = denial.Source
		result.Parts = append(result.Parts, model.Part{Text: "Denied by " + denial.Source + " DeniedHosts."})
	}
	body, err = json.Marshal(tool.Completion{CallID: call.ID, Name: call.Name, Result: result})
	if err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Completed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: called.ID, Payload: body})
	return err
}

func (e *Engine) recordProtectionChange(ctx context.Context, p profile.Profile, a worker.Assignment, failure *sandbox.ProtectionError) error {
	scope := a.Scope
	scope.Session = a.Session
	input, err := json.Marshal(map[string]any{"paths": failure.Paths, "member": p.Name})
	if err != nil {
		return err
	}
	call := model.ToolCall{ID: string(e.newID()), Name: "sandbox_protection", Input: input}
	body, err := json.Marshal(call)
	if err != nil {
		return err
	}
	called, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Called, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
	if err != nil {
		return err
	}
	result := tool.Result{IsError: true, Code: "MRK-5007", MemberName: p.Name, Parts: []model.Part{{Text: failure.Error()}}}
	body, err = json.Marshal(tool.Completion{CallID: call.ID, Name: call.Name, Result: result})
	if err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Completed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: called.ID, Payload: body})
	return err
}

func (e *Engine) recordFileDenial(ctx context.Context, p profile.Profile, a worker.Assignment, failure *sandbox.DenialError) error {
	scope := a.Scope
	scope.Session = a.Session
	input, err := json.Marshal(map[string]string{"details": failure.Details, "member": p.Name})
	if err != nil {
		return err
	}
	call := model.ToolCall{ID: string(e.newID()), Name: "sandbox_file", Input: input}
	body, err := json.Marshal(call)
	if err != nil {
		return err
	}
	called, err := e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Called, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
	if err != nil {
		return err
	}
	result := tool.Result{IsError: true, Code: "MRK-5009", MemberName: p.Name, Parts: []model.Part{{Text: failure.Error()}}}
	body, err = json.Marshal(tool.Completion{CallID: call.ID, Name: call.Name, Result: result})
	if err != nil {
		return err
	}
	_, err = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + a.Session), Scope: scope, Type: tool.Completed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Cause: called.ID, Payload: body})
	return err
}
