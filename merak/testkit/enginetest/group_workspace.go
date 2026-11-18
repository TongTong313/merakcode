package enginetest

import (
	"context"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/memory"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
)

func WorkspaceGroup(t *testing.T, dir string, providers map[string]model.Provider) (*engine.Engine, group.Group) {
	t.Helper()
	deps2 := Deps(t)
	deps2.Workdir = dir
	deps2.Providers = providers
	e, err := engine.New(deps2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	work.Memory = []memory.Scope{}
	lead.ID, lead.Model.Provider = "leader-profile", "leader"
	work.ID, work.Model.Provider = "worker-profile", "worker"
	g, err := CreateGroup(t, e, context.Background(), group.Group{Kind: group.KindLocal, Name: "Workspace", Project: group.Project{Directory: dir}, Leader: "leader"}, []group.Member{
		{ID: "human", Name: "Owner", Kind: group.MemberHuman, Role: "owner"},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "First worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
		{ID: "second", Name: "Second worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	return e, g
}
