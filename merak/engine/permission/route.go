package permission

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// Recipients selects online participants before other online humans and offline inboxes.
func Recipients(members []group.Member, role group.Role, participants []event.ID) []event.ID {
	var eligible, online, participating []event.ID
	for _, member := range members {
		if !member.Can(role) {
			continue
		}
		eligible = append(eligible, member.ID)
		if member.Status == group.Offline {
			continue
		}
		online = append(online, member.ID)
		if slices.Contains(participants, member.ID) {
			participating = append(participating, member.ID)
		}
	}
	if len(participating) > 0 {
		return participating
	}
	if len(online) > 0 {
		return online
	}
	return eligible
}

// Need classifies an operation before choosing the humans who may answer it.
func Need(req Request, ws workspace.Workspace, g group.Group) group.Role {
	if req.Kind == "budget" || req.Kind == "mode" || req.Kind == "default_leader" || req.Kind == "merge" && g.Settings.MergeApprovalRequired() {
		return group.RoleOwner
	}
	if req.Deletes || req.Kind == "launch" || req.Kind == "workspace" {
		return group.RoleAdmin
	}
	if req.Spec.Effect == tool.EffectNetwork {
		host, port := networkTarget(req.Host)
		if (sandbox.Network{Mode: "allowlist", Hosts: g.Settings.AllowedHosts, Deny: g.Settings.DeniedHosts}).AllowsHost(host, port) {
			return group.RoleApprover
		}
		return group.RoleAdmin
	}
	if req.Spec.Effect == tool.EffectWrite {
		path := req.Path
		if path == "" {
			var input struct{ Path string }
			_ = json.Unmarshal(req.Call.Input, &input)
			path = input.Path
		}
		if path == "" || ws.Directory == "" {
			return group.RoleAdmin
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(ws.Directory, path)
		}
		root, rootErr := resolvePath(ws.Directory)
		target, targetErr := resolvePath(path)
		if rootErr != nil || targetErr != nil {
			return group.RoleAdmin
		}
		for _, protected := range req.Call.Env.SandboxProfile.Protect {
			if within(protected, target) {
				return group.RoleAdmin
			}
		}
		for _, cache := range req.Call.Env.CacheDirectories {
			if within(cache, target) {
				return group.RoleApprover
			}
		}
		rel, err := filepath.Rel(root, target)
		if rootErr != nil || targetErr != nil || err != nil || !filepath.IsLocal(rel) {
			return group.RoleAdmin
		}
		rel = filepath.ToSlash(rel)
		if runtime.GOOS == "windows" {
			rel = strings.ToLower(rel)
		}
		for _, protected := range []string{".git/hooks", ".git/config", "merakcode.json", "merakcode.jsonc", ".merakcode"} {
			if rel == protected || strings.HasPrefix(rel, protected+"/") {
				return group.RoleAdmin
			}
		}
	}
	return group.RoleApprover
}

func within(root, path string) bool {
	root, rootErr := resolvePath(root)
	path, pathErr := resolvePath(path)
	rel, err := filepath.Rel(root, path)
	return rootErr == nil && pathErr == nil && err == nil && filepath.IsLocal(rel)
}

// New paths inherit the resolved parent so a symlink cannot lower the required role.
func resolvePath(path string) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", err
	}
	resolved, err = resolvePath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}
