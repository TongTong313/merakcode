// Package permission checks tool operations before they execute.
package permission

import (
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

type Mode string
type Decision string

const (
	ModeAsk      Mode = "ask"
	ModeAuto     Mode = "auto"
	ModeTakeover Mode = "takeover"
)

const (
	Allow Decision = "allow"
	Ask   Decision = "ask"
	Deny  Decision = "deny"
)

type Policy struct {
	Mode  Mode
	Rules []Rule
}

func (p Policy) Decide(call tool.Call, spec tool.Spec, status sandbox.Status) Decision {
	if p.Mode == ModeTakeover {
		return Allow
	}
	if p.Mode != ModeAsk && p.Mode != ModeAuto {
		return Deny
	}
	if spec.Effect == tool.EffectRead {
		return Allow
	}
	req := requestFor(call, spec)
	if spec.Effect == tool.EffectNetwork {
		host, port := networkTarget(req.Host)
		if call.Env.SandboxProfile.Network.DeniesHost(host, port) {
			return Deny
		}
	}
	if p.Mode != ModeAuto || !status.Available {
		return Ask
	}
	safeWrite := false
	if spec.Effect == tool.EffectWrite {
		if Need(req, workspace.Workspace{Directory: call.Env.Workdir}, group.Group{}) != group.RoleApprover {
			return Ask
		}
		safeWrite = true
	}
	if decision := ruleMatcher(p.Rules).decision(call, spec); decision != "" {
		return decision
	}
	if safeWrite {
		return Allow
	}
	if spec.Effect == tool.EffectNetwork && status.Network != "none" {
		host, port := networkTarget(req.Host)
		if call.Env.SandboxProfile.Network.AllowsHost(host, port) {
			return Allow
		}
	}
	return Ask
}
