package config

import (
	"encoding/json"
	"sort"
	"strings"
)

// The v0.3 permission key sets an action (allow, ask or deny) per category of what the agent does, and may name
// patterns inside a category. v1 enforces rules about commands and about paths that are written, so the entries that
// say that are turned into rules; every other entry stays in the file and is reported as not enforced yet.
var (
	commandCategories = map[string]bool{"bash": true, "bash_readonly": true, "bash_delete": true, "bash_risky": true, "bash_forbidden": true, "bash_unsandboxed": true}
	pathCategories    = map[string]bool{"edit": true, "protected_write": true, "external_write": true, "config_write": true}
)

func isAction(value string) bool { return value == "allow" || value == "ask" || value == "deny" }

// prefixOf turns a pattern such as "git push*" or "docs/**" into the prefix it stands for.
func prefixOf(pattern string) (string, bool) {
	prefix := strings.TrimSpace(pattern)
	for _, suffix := range []string{"/**", "/*", ":*", "**", "*"} {
		if strings.HasSuffix(prefix, suffix) {
			prefix = strings.TrimSpace(strings.TrimSuffix(prefix, suffix))
			break
		}
	}
	if prefix == "" || strings.ContainsAny(prefix, "*?[]{}") {
		return "", false
	}
	return prefix, true
}

// permissionRules reads the permission key of a configuration file.
func permissionRules(raw json.RawMessage) ([]PermissionRule, []string) {
	var categories map[string]json.RawMessage
	if json.Unmarshal(raw, &categories) != nil {
		return nil, []string{"permission: only an object of categories is understood; it is saved but not enforced"}
	}
	names := make([]string, 0, len(categories))
	for name := range categories {
		names = append(names, name)
	}
	sort.Strings(names)
	var rules []PermissionRule
	var warnings []string
	for _, name := range names {
		var patterns map[string]string
		if (!commandCategories[name] && !pathCategories[name]) || json.Unmarshal(categories[name], &patterns) != nil {
			warnings = append(warnings, "permission."+name+": saved but not enforced yet")
			continue
		}
		keys := make([]string, 0, len(patterns))
		for pattern := range patterns {
			keys = append(keys, pattern)
		}
		sort.Strings(keys)
		for _, pattern := range keys {
			prefix, ok := prefixOf(pattern)
			if !ok || !isAction(patterns[pattern]) {
				warnings = append(warnings, "permission."+name+"."+pattern+": saved but not enforced yet")
				continue
			}
			rule := PermissionRule{Decision: patterns[pattern]}
			if commandCategories[name] {
				rule.CommandPrefix = prefix
			} else {
				rule.PathPrefix = prefix
			}
			rules = append(rules, rule)
		}
	}
	return rules, warnings
}
