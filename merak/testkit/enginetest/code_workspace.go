package enginetest

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
)

func CodeEngine(t *testing.T, replies ...fake.Reply) (*engine.Engine, string, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	repo := IntegrationRepository(t)
	deps := Deps(t)
	deps.Workdir = repo
	deps.DataDir = t.TempDir()
	deps.Dirs = Dirs(t, deps.DataDir)
	deps.Providers = map[string]model.Provider{"fake": fake.New(t, replies...)}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	return e, repo, ctx
}
