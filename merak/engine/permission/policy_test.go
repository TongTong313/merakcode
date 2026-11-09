package permission_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
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
			if got := policy.Decide(tool.Call{}, tool.Spec{Effect: test.effect}); got != test.want {
				t.Fatalf("decision = %s, want %s", got, test.want)
			}
		})
	}
}

func TestTakeoverModeAllowsOperationsWithoutApproval(t *testing.T) {
	policy := permission.Policy{Mode: "takeover"}
	for _, effect := range []tool.Effect{tool.EffectRead, tool.EffectWrite, tool.EffectExec, tool.EffectNetwork, tool.EffectGroup} {
		t.Run(string(effect), func(t *testing.T) {
			if got := policy.Decide(tool.Call{}, tool.Spec{Effect: effect}); got != permission.Allow {
				t.Fatalf("takeover decision = %s, want allow", got)
			}
		})
	}
}
