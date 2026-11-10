package permission_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestRememberedPermissionsRespectSessionAndPersistAlwaysChoices(t *testing.T) {
	for _, remember := range []string{"session", "always"} {
		for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
			t.Run(remember+" "+string(decision), func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "config.json")
				settings, err := config.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				asked := 0
				gate := permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Grants: permission.NewGrants(func() permission.Settings { return settings }), Ask: func(context.Context, permission.Request) (permission.Reply, error) {
					asked++
					return permission.Reply{Decision: decision, Remember: remember}, nil
				}}
				call := tool.Call{ID: "one", Name: "write_marker", Env: tool.Env{Member: "worker", Workdir: t.TempDir(), Scope: event.Scope{Session: "first"}}}
				run := func() {
					t.Helper()
					result, err := gate.Wrap(markerTool{}).Run(context.Background(), call)
					if err != nil || result.IsError != (decision == permission.Deny) {
						t.Fatalf("result=%+v err=%v", result, err)
					}
				}
				run()
				call.ID = "two"
				run()
				if asked != 1 {
					t.Fatalf("same session approvals=%d", asked)
				}
				if remember == "always" {
					settings, err = config.Open(path)
					if err != nil {
						t.Fatal(err)
					}
					gate.Grants = permission.NewGrants(func() permission.Settings { return settings })
				}
				call.Env.Scope.Session = "second"
				run()
				want := 2
				if remember == "always" {
					want = 1
				}
				if asked != want {
					t.Fatalf("new session approvals=%d want=%d", asked, want)
				}
				call.Env.Member = "another-worker"
				run()
				if asked != want+1 {
					t.Fatal("remembered approval crossed member identity")
				}
			})
		}
	}
}
