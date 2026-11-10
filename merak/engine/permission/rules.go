package permission

import (
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

type Rule = config.PermissionRule

func (r ruleMatcher) decision(call tool.Call, spec tool.Spec) Decision {
	var input struct {
		Path    string `json:"path"`
		Command string `json:"command"`
	}
	if json.Unmarshal(call.Input, &input) != nil {
		return ""
	}
	input.Path = requestFor(call, spec).Path
	decision := Decision("")
	for _, rule := range r {
		if rule.Tool != "" && rule.Tool != spec.Name || rule.Project != "" && !samePath(rule.Project, call.Env.Workdir) {
			continue
		}
		matches := false
		if rule.CommandPrefix != "" && spec.Effect == tool.EffectExec {
			command, prefix := strings.TrimSpace(input.Command), strings.TrimSpace(rule.CommandPrefix)
			matches = command == prefix || strings.HasPrefix(command, prefix+" ")
			if rule.Decision == string(Allow) && strings.ContainsAny(command, ";|&\n\r`$<>") {
				matches = false
			}
		}
		if rule.PathPrefix != "" && input.Path != "" && spec.Effect == tool.EffectWrite {
			path := input.Path
			if !filepath.IsAbs(path) {
				path = filepath.Join(call.Env.Workdir, path)
			}
			prefix := rule.PathPrefix
			if !filepath.IsAbs(prefix) {
				prefix = filepath.Join(call.Env.Workdir, prefix)
			}
			path, pathErr := resolvePath(path)
			prefix, prefixErr := resolvePath(prefix)
			rel, relErr := filepath.Rel(prefix, path)
			matches = pathErr == nil && prefixErr == nil && relErr == nil && filepath.IsLocal(rel)
		}
		if !matches {
			continue
		}
		if rule.Decision == string(Deny) {
			return Deny
		}
		if rule.Decision == string(Ask) || decision == "" {
			decision = Decision(rule.Decision)
		}
	}
	return decision
}

type ruleMatcher []Rule

func samePath(first, second string) bool {
	a, aErr := resolvePath(first)
	b, bErr := resolvePath(second)
	rel, relErr := filepath.Rel(a, b)
	return aErr == nil && bErr == nil && relErr == nil && rel == "."
}
