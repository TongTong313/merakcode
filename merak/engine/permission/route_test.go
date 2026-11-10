package permission_test

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"path/filepath"
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func TestApprovalRolesFollowTheOperationAndWorkspace(t *testing.T) {
	directory := t.TempDir()
	ws := workspace.Workspace{Directory: directory}
	g := group.Group{Settings: group.Settings{AllowedHosts: []string{"api.example.test"}, MergeNeedsOwner: new(true)}}
	for _, tc := range []struct {
		name             string
		effect           tool.Effect
		kind, path, host string
		deletes          bool
		want             group.Role
	}{
		{name: "workspace write", effect: tool.EffectWrite, path: "result.md", want: group.RoleApprover},
		{name: "outside write", effect: tool.EffectWrite, path: filepath.Join(directory, "..", "outside.md"), want: group.RoleAdmin},
		{name: "unknown external write", effect: tool.EffectWrite, want: group.RoleAdmin},
		{name: "deletion", effect: tool.EffectWrite, path: "old.md", deletes: true, want: group.RoleAdmin},
		{name: "protected git hook", effect: tool.EffectWrite, path: ".git/hooks/pre-commit", want: group.RoleAdmin},
		{name: "protected project configuration", effect: tool.EffectWrite, path: "merakcode.jsonc", want: group.RoleAdmin},
		{name: "ordinary command", effect: tool.EffectExec, want: group.RoleApprover},
		{name: "known network host", effect: tool.EffectNetwork, host: "api.example.test", want: group.RoleApprover},
		{name: "new network host", effect: tool.EffectNetwork, host: "new.example.test", want: group.RoleAdmin},
		{name: "merge approval", kind: "merge", want: group.RoleOwner},
		{name: "budget change", kind: "budget", want: group.RoleOwner},
		{name: "permission mode change", kind: "mode", want: group.RoleOwner},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, _ := json.Marshal(map[string]any{"path": tc.path})
			req := permission.Request{Spec: tool.Spec{Effect: tc.effect}, Call: tool.Call{Input: input}, Kind: tc.kind, Host: tc.host, Deletes: tc.deletes}
			if got := permission.Need(req, ws, g); got != tc.want {
				t.Fatalf("role=%s want=%s", got, tc.want)
			}
		})
	}
}

func TestHumanRoutingPrefersOnlineTaskParticipantsThenTheGroup(t *testing.T) {
	for _, tc := range []struct {
		name               string
		participant, other group.Status
		want               []event.ID
	}{
		{"online participant first", group.Idle, group.Idle, []event.ID{"participant"}},
		{"online group fallback", group.Offline, group.Idle, []event.ID{"other"}},
		{"offline inbox fallback", group.Offline, group.Offline, []event.ID{"participant", "other"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			members := []group.Member{
				{ID: "viewer", Kind: group.MemberHuman, Status: group.Idle},
				{ID: "participant", Kind: group.MemberHuman, Role: group.RoleApprover, Status: tc.participant},
				{ID: "other", Kind: group.MemberHuman, Role: group.RoleOwner, Status: tc.other},
				{ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Role: group.RoleOwner, Status: group.Idle},
			}
			got := permission.Recipients(members, group.RoleApprover, []event.ID{"viewer", "participant"})
			if !slices.Equal(got, tc.want) {
				t.Fatalf("recipients=%v want=%v", got, tc.want)
			}
		})
	}
}
