//go:build !windows

package permission_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func TestRememberedWriteRequiresApprovalWhenSymlinkTargetChanges(t *testing.T) {
	workspace, outside := t.TempDir(), t.TempDir()
	inside := filepath.Join(workspace, "inside")
	if err := os.Mkdir(inside, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(workspace, "link")
	if err := os.Symlink(inside, link); err != nil {
		t.Fatal(err)
	}
	settings := config.NewMemory()
	count := 0
	gate := permission.Gate{Policy: permission.Policy{Mode: permission.ModeAsk}, Grants: permission.NewGrants(func() permission.Settings { return settings }), Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		count++
		if count == 1 {
			return permission.Reply{Decision: permission.Allow, Remember: "always"}, nil
		}
		return permission.Reply{Decision: permission.Deny}, nil
	}}
	call := tool.Call{Input: json.RawMessage(`{"path":"link/a.txt","content":"approved"}`), Env: tool.Env{Workdir: workspace, Scope: event.Scope{Session: "chat"}, Reads: new(tool.Reads)}}
	if result, err := gate.Wrap(tool.WriteFile{}).Run(context.Background(), call); err != nil || result.IsError {
		t.Fatalf("first write=%+v %v", result, err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if result, err := gate.Wrap(tool.WriteFile{}).Run(context.Background(), call); err != nil || !result.IsError {
		t.Fatalf("changed target write=%+v %v", result, err)
	}
	if count != 2 {
		t.Fatalf("approval count=%d", count)
	}
	if _, err := os.Stat(filepath.Join(outside, "a.txt")); !os.IsNotExist(err) {
		t.Fatal("remembered permission escaped its original target")
	}
}
