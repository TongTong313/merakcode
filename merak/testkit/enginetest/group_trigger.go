package enginetest

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
)

func TriggerGroup(t *testing.T, settings group.Settings, providers map[string]model.Provider) (*engine.Engine, group.Group) {
	t.Helper()
	directory := t.TempDir()
	deps2 := Deps(t)
	deps2.Workdir = directory
	deps2.Providers = providers
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := CreateGroup(t, e, context.Background(), group.Group{Kind: group.KindLocal, Name: "Rules", Project: group.Project{Directory: directory}, Leader: "leader", Settings: settings}, []group.Member{
		{ID: "owner", Kind: group.MemberHuman, Name: "Owner", Role: group.RoleOwner},
		{ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader", Agent: lead.ID},
		{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Name: "Worker", Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return e, g
}
