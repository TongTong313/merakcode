// Package permission checks tool operations before they execute.
package permission

import "github.com/TongTong313/merakcode/merak/engine/tool"

type Mode string
type Decision string

const ModeAsk Mode = "ask"

const (
	Allow Decision = "allow"
	Ask   Decision = "ask"
	Deny  Decision = "deny"
)

type Policy struct {
	Mode Mode
}

func (p Policy) Decide(_ tool.Call, spec tool.Spec) Decision {
	if p.Mode != ModeAsk {
		return Deny
	}
	if spec.Effect == tool.EffectRead {
		return Allow
	}
	return Ask
}
