package config_test

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
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

func TestUserNetworkDenialsPersistAndRejectAnUnboundedWildcard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "user.json")
	settings, err := config.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	denied := []string{"*.blocked.example.com:443", "api.example.com"}
	if _, err := settings.Update(config.Patch{DeniedHosts: &denied}); err != nil {
		t.Fatal(err)
	}
	reopened, err := config.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(reopened.Get().DeniedHosts, denied) {
		t.Fatalf("denied hosts=%v", reopened.Get().DeniedHosts)
	}
	invalid := []string{"*"}
	if _, err := reopened.Update(config.Patch{DeniedHosts: &invalid}); err == nil {
		t.Fatal("denial accepted an unbounded wildcard")
	}
	if !slices.Equal(reopened.Get().DeniedHosts, denied) {
		t.Fatal("invalid denial changed the saved policy")
	}
}
