package permission

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"path/filepath"
	"runtime"
	"strings"
)

// Need classifies an operation before choosing the humans who may answer it.
func Need(req Request, directory string, options NeedOptions) string {
	if req.Kind == "budget" || req.Kind == "mode" || req.Kind == "default_leader" || req.Kind == "merge" && !options.MergeWithoutOwner {
		return NeedOwner
	}
	if req.Deletes || req.Kind == "launch" || req.Kind == "workspace" {
		return NeedAdmin
	}
	if req.Spec.Effect == tool.EffectNetwork {
		host, port := networkTarget(req.Host)
		if (sandbox.Network{Mode: "allowlist", Hosts: options.AllowedHosts, Deny: options.DeniedHosts}).AllowsHost(host, port) {
			return NeedApprover
		}
		return NeedAdmin
	}
	if req.Spec.Effect == tool.EffectWrite {
		path := req.Path
		if path == "" {
			var input struct{ Path string }
			_ = json.Unmarshal(req.Call.Input, &input)
			path = input.Path
		}
		if path == "" || directory == "" {
			return NeedAdmin
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(directory, path)
		}
		root, rootErr := resolvePath(directory)
		target, targetErr := resolvePath(path)
		if rootErr != nil || targetErr != nil {
			return NeedAdmin
		}
		for _, protected := range req.Call.Env.SandboxProfile.Protect {
			if within(protected, target) {
				return NeedAdmin
			}
		}
		for _, cache := range req.Call.Env.CacheDirectories {
			if within(cache, target) {
				return NeedApprover
			}
		}
		rel, err := filepath.Rel(root, target)
		if rootErr != nil || targetErr != nil || err != nil || !filepath.IsLocal(rel) {
			return NeedAdmin
		}
		rel = filepath.ToSlash(rel)
		if runtime.GOOS == "windows" {
			rel = strings.ToLower(rel)
		}
		for _, protected := range []string{".git/hooks", ".git/config", "merakcode.json", "merakcode.jsonc", ".merakcode"} {
			if rel == protected || strings.HasPrefix(rel, protected+"/") {
				return NeedAdmin
			}
		}
	}
	return NeedApprover
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

// The level of person an operation needs. A group maps each to its role of the same name.
const (
	NeedApprover = "approver"
	NeedAdmin    = "admin"
	NeedOwner    = "owner"
)

// NeedOptions carries what the owner of a session decided about approvals; the zero value is the strictest.
type NeedOptions struct {
	MergeWithoutOwner bool
	AllowedHosts      []string
	DeniedHosts       []string
}
