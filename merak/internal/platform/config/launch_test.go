package config_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestRememberedLaunchDecisionsRejectInvalidValues(t *testing.T) {
	for _, value := range []config.LaunchDecision{
		{Member: "member", Project: t.TempDir(), Decision: "ask"},
		{Member: "member", Project: t.TempDir(), Decision: ""},
		{Member: "", Project: t.TempDir(), Decision: "allow"},
		{Member: "member", Project: "relative", Decision: "allow"},
		{Member: "member", Project: "", Decision: "deny"},
	} {
		t.Run(value.Member+"/"+value.Decision+"/"+value.Project, func(t *testing.T) {
			settings := config.NewMemory()
			if err := settings.RememberUnconfinedDecision(value.Member, value.Project, value.Decision); err == nil {
				t.Error("invalid remembered decision was accepted")
			}
			if len(settings.Get().Unconfined) != 0 {
				t.Error("invalid remembered decision changed configuration")
			}
		})
	}
}
