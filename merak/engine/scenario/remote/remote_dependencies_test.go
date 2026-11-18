package remote_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestRemoteConnectionsRequireAnInjectedDialer(t *testing.T) {
	deps := enginetest.Deps(t)
	deps.DataDir = t.TempDir()
	deps.Dirs = enginetest.Dirs(t, deps.DataDir)
	deps.Workdir = t.TempDir()
	deps.Store = memory.New()
	deps.Vault = vault.NewMemory()
	deps.Dial = nil
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	_, err = e.ConnectRemote(t.Context(), wire.RemoteConnectParams{Endpoint: "ws://127.0.0.1:0", Token: "token"})
	if err == nil || err.Error() != "MRK-3001" {
		t.Fatalf("missing dialer error = %v, want MRK-3001", err)
	}
}
