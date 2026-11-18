package remote_test

import (
	"errors"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestCloudLoginRequiresAnInjectedLinkFactory(t *testing.T) {
	deps := enginetest.Deps(t)
	deps.Workdir = t.TempDir()
	deps.Store = memory.New()
	deps.Vault = vault.NewMemory()
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	err = e.ConnectCloud(t.Context(), wire.Credentials{
		Endpoint: "ws://127.0.0.1:0", Token: "token", Account: "account", Device: "device",
	})
	if !errors.Is(err, wire.ErrNoCloud) {
		t.Fatalf("missing link factory error = %v, want %v", err, wire.ErrNoCloud)
	}
}
