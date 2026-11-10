package engine_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestClaudeMCPReportIsSubmittedToItsAssignedTask(t *testing.T) {
	testProductMCPReport(t, worker.KindClaudeCode)
}

func TestExternalProductsSubmitMCPReports(t *testing.T) {
	for _, kind := range []worker.Kind{worker.KindCodex, worker.KindACP, worker.KindOpenCode, worker.KindPi} {
		t.Run(string(kind), func(t *testing.T) { testProductMCPReport(t, kind) })
	}
}

func testProductMCPReport(t *testing.T, kind worker.Kind) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	bin := t.TempDir()
	claude, merak := filepath.Join(bin, "claude.exe"), filepath.Join(bin, "merak.exe")
	folder := string(kind)
	fixture := folder
	if kind == worker.KindClaudeCode {
		folder, fixture = "claudecode", "claude"
	}
	for _, build := range []struct{ path, source string }{{claude, "./worker/" + folder + "/testdata/fake" + fixture}, {merak, "../cmd/merak"}} {
		if out, err := process.Command(ctx, "", "go", "build", "-o", build.path, build.source).CombinedOutput(); err != nil {
			t.Fatalf("build: %s %v", out, err)
		}
	}
	directory := t.TempDir()
	e, err := engine.New(engine.Deps{MCPCommand: merak, Workdir: directory, Providers: map[string]model.Provider{"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting."} }}}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := profile.DefaultLeader(), profile.DefaultWorker()
	lead.ID, lead.Model.Provider = "lead-profile", "leader"
	work.ID, work.Mode = "work-profile", permission.ModeTakeover
	work.Product = &profile.Product{Kind: kind, Binary: claude, Env: map[string]string{"MERAKCODE_FIXTURE_MCP": "1", "MERAKCODE_FIXTURE_APPROVAL": "never"}}
	if kind == worker.KindClaudeCode {
		work.Product.Args = []string{"--mcp-report"}
		work.Mode = permission.ModeAsk
	}
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "MCP", Project: group.Project{Directory: directory}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	}, []profile.Profile{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
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
