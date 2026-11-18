package sandbox_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func TestClaudeMCPReportIsSubmittedToItsAssignedTask(t *testing.T) {
	testProductMCPReport(t, definition.KindClaudeCode)
}

func TestExternalProductsSubmitMCPReports(t *testing.T) {
	for _, kind := range []definition.Kind{definition.KindCodex, definition.KindACP, definition.KindOpenCode, definition.KindPi} {
		t.Run(string(kind), func(t *testing.T) { testProductMCPReport(t, kind) })
	}
}

func testProductMCPReport(t *testing.T, kind definition.Kind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	bin := t.TempDir()
	claude, merak := filepath.Join(bin, "claude.exe"), filepath.Join(bin, "merak.exe")
	folder := string(kind)
	fixture := folder
	if kind == definition.KindClaudeCode {
		folder, fixture = "claudecode", "claude"
	}
	for _, build := range []struct{ path, source string }{{claude, "github.com/TongTong313/merakcode/merak/engine/collab/worker/" + folder + "/testdata/fake" + fixture}, {merak, "github.com/TongTong313/merakcode/merak/cmd/merak"}} {
		if out, err := process.Command(ctx, "", "go", "build", "-o", build.path, build.source).CombinedOutput(); err != nil {
			t.Fatalf("build: %s %v", out, err)
		}
	}
	directory := t.TempDir()
	deps := enginetest.Deps(t)
	deps.MCPCommand = merak
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"leader": enginetest.GroupScript{ProviderName: "leader", Test: t, Reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := definition.DefaultMerakCode(), definition.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-profile", "leader"
	work.ID, work.Mode = "work-profile", permission.ModeTakeover
	work.Product = &definition.Product{Kind: kind, Binary: claude, Env: map[string]string{"MERAKCODE_FIXTURE_MCP": "1", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	if kind == definition.KindClaudeCode {
		work.Product.Args = []string{"--mcp-report"}
		work.Mode = permission.ModeAsk
	}
	g, err := enginetest.CreateGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "MCP", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []definition.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Use MCP", Workspace: "inplace", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		updated, err := event.Decode[task.Card](fact)
		if err != nil || updated.ID != card.ID || len(updated.Claims) != 1 || updated.Claims[0].Report == nil {
			t.Fatalf("card=%+v err=%v", updated, err)
		}
		report := updated.Claims[0].Report
		if report.Summary != "Report submitted through MCP." || report.Verdict != task.VerdictDone {
			t.Fatalf("report=%+v", report)
		}
	case <-ctx.Done():
		t.Fatal("MCP report did not reach the task")
	}
}
