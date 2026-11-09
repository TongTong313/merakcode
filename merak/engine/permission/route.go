package permission

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"path/filepath"
	"runtime"
	"strings"
)

// Need classifies an operation before choosing the humans who may answer it.
func Need(req Request, ws workspace.Workspace, g group.Group) group.Role {
	if req.Kind == "budget" || req.Kind == "mode" || req.Kind == "default_leader" || req.Kind == "merge" && g.Settings.MergeNeedsOwner {
		return group.RoleOwner
	}
	if req.Deletes || req.Kind == "launch" {
		return group.RoleAdmin
	}
	if req.Spec.Effect == tool.EffectNetwork {
		for _, host := range g.Settings.AllowedHosts {
			if req.Host != "" && strings.EqualFold(strings.TrimSuffix(host, "."), strings.TrimSuffix(req.Host, ".")) {
				return group.RoleApprover
			}
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
