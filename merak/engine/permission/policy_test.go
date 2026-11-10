package permission_test

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestAskModeAllowsReadsAndAsksBeforeWrites(t *testing.T) {
	for _, test := range []struct {
		name   string
		mode   permission.Mode
		effect tool.Effect
		want   permission.Decision
	}{
		{"allows reads", permission.ModeAsk, tool.EffectRead, permission.Allow},
		{"asks before writes", permission.ModeAsk, tool.EffectWrite, permission.Ask},
		{"asks before commands", permission.ModeAsk, tool.EffectExec, permission.Ask},
		{"asks for unknown effects", permission.ModeAsk, "invalid", permission.Ask},
		{"rejects an unknown mode", "invalid", tool.EffectRead, permission.Deny},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := permission.Policy{Mode: test.mode}
			if got := policy.Decide(tool.Call{}, tool.Spec{Effect: test.effect}, sandbox.Status{}); got != test.want {
				t.Fatalf("decision = %s, want %s", got, test.want)
			}
		})
	}
}

func TestAutoModeAllowsWorkspaceWritesAndAsksForDangerousTargets(t *testing.T) {
	directory := t.TempDir()
	for _, tc := range []struct {
		name, path string
		effect     tool.Effect
		available  bool
		want       permission.Decision
	}{
		{"read without sandbox", "source.go", tool.EffectRead, false, permission.Allow},
		{"workspace write", "source.go", tool.EffectWrite, true, permission.Allow},
		{"outside write", filepath.Join(directory, "..", "outside.go"), tool.EffectWrite, true, permission.Ask},
		{"protected hook", ".git/hooks/pre-commit", tool.EffectWrite, true, permission.Ask},
		{"protected configuration", "merakcode.jsonc", tool.EffectWrite, true, permission.Ask},
		{"unavailable sandbox", "source.go", tool.EffectWrite, false, permission.Ask},
		{"unlisted command", "", tool.EffectExec, true, permission.Ask},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, _ := json.Marshal(map[string]string{"path": tc.path})
			call := tool.Call{Input: input, Env: tool.Env{Workdir: directory}}
			policy := permission.Policy{Mode: "auto"}
			status := sandbox.Status{Available: tc.available, Network: "ports"}
			if got := policy.Decide(call, tool.Spec{Effect: tc.effect}, status); got != tc.want {
				t.Fatalf("decision=%s want=%s", got, tc.want)
			}
		})
	}
}

func TestTakeoverModeAllowsOperationsWithoutApproval(t *testing.T) {
	policy := permission.Policy{Mode: "takeover"}
	for _, effect := range []tool.Effect{tool.EffectRead, tool.EffectWrite, tool.EffectExec, tool.EffectNetwork, tool.EffectGroup} {
		t.Run(string(effect), func(t *testing.T) {
			if got := policy.Decide(tool.Call{}, tool.Spec{Effect: effect}, sandbox.Status{}); got != permission.Allow {
				t.Fatalf("takeover decision = %s, want allow", got)
			}
		})
	}
}

func TestAutoModeAllowsOnlyTheAssignedPackageCacheAndStillAsksForDeletion(t *testing.T) {
	workspace, cache := t.TempDir(), t.TempDir()
	for _, tc := range []struct {
		name, path string
		deletes    bool
		want       permission.Decision
	}{
		{"assigned cache", filepath.Join(cache, "artifact"), false, permission.Allow},
		{"outside cache", filepath.Join(cache, "..", "unrelated"), false, permission.Ask},
		{"cache deletion", filepath.Join(cache, "artifact"), true, permission.Ask},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, _ := json.Marshal(map[string]any{"path": tc.path, "deletes": tc.deletes})
			call := tool.Call{Input: input, Env: tool.Env{Workdir: workspace, CacheDirectories: []string{cache}}}
			if got := (permission.Policy{Mode: permission.ModeAuto}).Decide(call, tool.Spec{Effect: tool.EffectWrite}, sandbox.Status{Available: true}); got != tc.want {
				t.Fatalf("decision=%s want=%s", got, tc.want)
			}
		})
	}
}

func TestPathRulesApplyToExternalProductFilePaths(t *testing.T) {
	for _, field := range []string{"path", "file_path"} {
		for _, decision := range []permission.Decision{permission.Ask, permission.Deny} {
			t.Run(field+" "+string(decision), func(t *testing.T) {
				input, _ := json.Marshal(map[string]string{field: "private/a.txt"})
				policy := permission.Policy{Mode: permission.ModeAuto, Rules: []permission.Rule{{PathPrefix: "private", Decision: string(decision)}}}
				got := policy.Decide(tool.Call{Input: input, Env: tool.Env{Workdir: t.TempDir()}}, tool.Spec{Effect: tool.EffectWrite}, sandbox.Status{Available: true})
				if got != decision {
					t.Fatalf("decision=%s want=%s", got, decision)
				}
			})
		}
	}
}

func TestUserCommandPrefixesAllowOnlyTheSelectedCommands(t *testing.T) {
	for _, tc := range []struct {
		name, command string
		available     bool
		want          permission.Decision
	}{
		{"matching command", "go test ./...", true, permission.Allow},
		{"different command", "go testing", true, permission.Ask},
		{"additional shell command", "go test ./...; rm file", true, permission.Ask},
		{"unavailable sandbox", "go test ./...", false, permission.Ask},
		{"explicit ask rule", "git push origin main", true, permission.Ask},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, _ := json.Marshal(map[string]string{"command": tc.command})
			policy := permission.Policy{Mode: permission.ModeAuto, Rules: []permission.Rule{
				{CommandPrefix: "go test", Decision: "allow"},
				{CommandPrefix: "git", Decision: "allow"},
				{CommandPrefix: "git push", Decision: "ask"},
			}}
			got := policy.Decide(tool.Call{Input: input}, tool.Spec{Effect: tool.EffectExec}, sandbox.Status{Available: tc.available, Network: "ports"})
			if got != tc.want {
				t.Fatalf("command=%q decision=%s want=%s", tc.command, got, tc.want)
			}
		})
	}
}

func TestAutoModeAllowsApprovedNetworkHostsAndDeniesExplicitExclusions(t *testing.T) {
	policy := permission.Policy{Mode: permission.ModeAuto}
	for _, tc := range []struct {
		url  string
		want permission.Decision
	}{
		{"https://api.example.com/data", permission.Allow},
		{"https://blocked.example.com/data", permission.Deny},
		{"https://example.com/data", permission.Ask},
		{"https://api.example.com:8443/data", permission.Ask},
	} {
		t.Run(tc.url, func(t *testing.T) {
			input, _ := json.Marshal(map[string]string{"url": tc.url})
			call := tool.Call{Input: input, Env: tool.Env{SandboxProfile: sandbox.Profile{
				Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"*.example.com:443"}, Deny: []string{"blocked.example.com"}},
			}}}
			got := policy.Decide(call, tool.Spec{Effect: tool.EffectNetwork}, sandbox.Status{Available: true, Network: "ports"})
			if got != tc.want {
				t.Fatalf("decision=%s want=%s", got, tc.want)
			}
		})
	}
}
