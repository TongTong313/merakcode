package configfile_test

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/storage/configfile"
)

func TestUserNetworkDenialsPersistAndRejectAnUnboundedWildcard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "user.json")
	settings, err := configfile.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	denied := []string{"*.blocked.example.com:443", "api.example.com"}
	if _, err := settings.Update(config.Patch{DeniedHosts: &denied}); err != nil {
		t.Fatal(err)
	}
	reopened, err := configfile.Open(path)
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
