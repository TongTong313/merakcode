package config_test

import (
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/config"
)

func TestConfigurationRejectsInvalidNetworkHosts(t *testing.T) {
	for _, host := range []string{"https://example.com", "example.com:65536", "example.*.com", "example.com/path", ""} {
		t.Run(host, func(t *testing.T) {
			settings := config.NewMemory()
			hosts := []string{host}
			if _, err := settings.Update(config.Patch{AllowedHosts: &hosts}); err == nil {
				t.Fatalf("saved invalid network host %q", host)
			}
			if len(settings.AllowedNetworkHosts()) != 0 {
				t.Fatal("invalid update changed network settings")
			}
		})
	}
}

func TestUserMayAllowEveryHostWhileRetainingExplicitDenials(t *testing.T) {
	settings := config.NewMemory()
	allowed, denied := []string{"*"}, []string{"blocked.example:443"}
	if _, err := settings.Update(config.Patch{AllowedHosts: &allowed, DeniedHosts: &denied}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(settings.AllowedNetworkHosts(), allowed) || !slices.Equal(settings.DeniedNetworkHosts(), denied) {
		t.Fatalf("network rules=%+v", settings.Get())
	}
}
