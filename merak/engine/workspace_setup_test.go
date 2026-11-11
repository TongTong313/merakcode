package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func init() {
	if len(os.Args) != 3 || os.Args[1] != "--workspace-setup-fixture" {
		return
	}
	if os.Args[2] == "protected" {
		home, _ := os.UserHomeDir()
		if _, err := os.ReadFile(filepath.Join(home, ".codex", "fixture")); err == nil {
			os.Exit(24)
		}
	}
	file, err := os.OpenFile("installed.txt", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(2)
	}
	_, _ = file.WriteString("ready\n")
	_ = file.Close()
	fmt.Println("Setup diagnostic")
	if os.Args[2] == "hold" {
		for {
			time.Sleep(time.Hour)
		}
	}
	if os.Args[2] == "fail" {
		os.Exit(23)
	}
	os.Exit(0)
}

func TestPooledWorkspaceKeepsSuccessfulSetupAcrossClaims(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir := integrationRepository(t)
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("installed.txt\n"), 0600); err != nil {
		t.Fatal(err)
	}
	fixtureGit(t, dir, "add", ".gitignore")
	fixtureGit(t, dir, "commit", "-m", "Ignore setup cache")
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{
		"leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }},
		"worker": groupScript{name: "worker", test: t, reply: func(model.Request) fake.Reply {
			return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Prepared"})
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead, work := agent.DefaultLeader(), agent.DefaultWorker()
	lead.ID, lead.Model.Provider = "lead", "leader"
	work.ID, work.Model.Provider, work.Mode = "work", "worker", permission.ModeTakeover
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Reuse setup", Project: group.Project{Directory: dir}, Leader: "leader", Settings: group.Settings{Setup: []string{binary, "--workspace-setup-fixture", "success"}}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	reports, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
	defer stop()
	previous := ""
	for i := range 2 {
		card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: fmt.Sprint("Claim ", i), CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
		if err != nil {
			t.Fatal(err)
		}
		select {
		case fact := <-reports:
			if fact.Scope.Task != card.ID {
				t.Fatalf("report=%+v", fact)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		card, err = e.Tasks.Get(ctx, card.ID)
		if err != nil {
			t.Fatal(err)
		}
		ws, err := e.Workspaces.Get(ctx, card.Claims[0].Workspace)
		if err != nil {
			t.Fatal(err)
		}
		if ws.Kind != workspace.KindWorktree || previous != "" && ws.Directory != previous {
			t.Fatalf("workspace=%+v previous=%s", ws, previous)
		}
		data, err := os.ReadFile(filepath.Join(ws.Directory, "installed.txt"))
		if err != nil || string(data) != "ready\n" {
			t.Fatalf("setup ran again: %q %v", data, err)
		}
		previous = ws.Directory
		if err = e.Workspaces.Release(ctx, ws); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWorkspaceSetupRunsBeforeWorkerAndFailureBlocksWithLog(t *testing.T) {
	for _, mode := range []string{"success", "fail", "hold", "protected"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "protected" {
				if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
					t.Skip("requires a native Unix sandbox")
				}
				home := t.TempDir()
				t.Setenv("HOME", home)
				if err := os.Mkdir(filepath.Join(home, ".codex"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(home, ".codex", "fixture"), []byte("fixture credentials"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			storage := memory.New()
			var e *engine.Engine
			provider := groupScript{name: "worker", test: t, reply: func(req model.Request) fake.Reply {
				if mode != "success" && mode != "protected" {
					t.Error("worker ran after failed or cancelled setup")
				}
				docs, err := storage.List(ctx, "workspace", "")
				if err != nil || len(docs) != 1 {
					t.Fatalf("workspaces=%v %v", docs, err)
				}
				ws, err := e.Workspaces.Get(ctx, event.ID(docs[0].Key))
				if err != nil {
					t.Fatal(err)
				}
				body, err := os.ReadFile(filepath.Join(ws.Directory, "installed.txt"))
				if err != nil || string(body) != "ready\n" {
					t.Errorf("setup=%q %v", body, err)
				}
				return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Setup checked"})
			}}
			e, err = engine.New(engine.Deps{Store: storage, Workdir: t.TempDir(), Ask: func(context.Context, permission.Request) (permission.Reply, error) {
				return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
			}, Providers: map[string]model.Provider{"worker": provider, "leader": groupScript{name: "leader", test: t, reply: func(model.Request) fake.Reply { return fake.Reply{Text: "Waiting"} }}}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			lead, work := agent.DefaultLeader(), agent.DefaultWorker()
			lead.ID, lead.Model.Provider = "lead", "leader"
			work.ID, work.Model.Provider, work.Mode = "work", "worker", permission.ModeTakeover
			if mode == "protected" {
				work.Mode = permission.ModeAsk
			}
			body, _ := json.Marshal(map[string]any{"setup": []string{binary, "--workspace-setup-fixture", mode}})
			var settings group.Settings
			if err := json.Unmarshal(body, &settings); err != nil {
				t.Fatal(err)
			}
			g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Setup", Leader: "leader", Project: group.Project{Directory: t.TempDir()}, Settings: settings}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: work.ID}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}}, []agent.Agent{lead, work})
			if err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Group: g.ID}, Types: []event.Type{task.Reported}})
			defer stop()
			card, err := e.CreateAssignedTask(ctx, task.Card{Group: g.ID, Title: "Prepare workspace", Workspace: "folder", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}, "worker")
			if err != nil {
				t.Fatal(err)
			}
			if mode == "hold" {
				finished, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Task: card.ID}, Types: []event.Type{"workspace.setup"}})
				defer stop()
				for {
					docs, err := storage.List(ctx, "workspace", "")
					if err != nil {
						t.Fatal(err)
					}
					if len(docs) > 0 {
						ws, err := e.Workspaces.Get(ctx, event.ID(docs[0].Key))
						if err == nil {
							if _, err := os.Stat(filepath.Join(ws.Directory, "installed.txt")); err == nil {
								break
							}
						}
					}
					select {
					case <-time.After(5 * time.Millisecond):
					case <-ctx.Done():
						t.Fatal("setup process did not start")
					}
				}
				if err := e.Tasks.SetPhase(ctx, card.ID, task.PhaseCancelled, event.Actor{Kind: event.ActorHuman, ID: "owner"}); err != nil {
					t.Fatal(err)
				}
				select {
				case <-finished:
				case <-ctx.Done():
					t.Fatal("cancelled task kept its setup process running")
				}
				current, err := e.Tasks.Get(ctx, card.ID)
				if err != nil || current.Status != task.Cancelled {
					t.Fatalf("cancelled=%+v %v", current, err)
				}
				return
			}
			select {
			case fact := <-facts:
				result, err := event.Decode[task.Card](fact)
				if err != nil || len(result.Claims) != 1 {
					t.Fatalf("card=%+v %v", result, err)
				}
				if mode == "fail" && (result.Status != task.Blocked || result.Claims[0].Report.Verdict != task.VerdictBlocked) {
					t.Fatalf("failure=%+v", result)
				}
				if mode == "protected" && result.Claims[0].Report.Verdict != task.VerdictDone {
					t.Fatalf("setup could read product credentials: %+v", result.Claims[0].Report)
				}
			case <-ctx.Done():
				t.Fatal("setup claim did not finish")
			}
			setup, err := e.FindEvents(ctx, store.Query{Scope: event.Scope{Task: card.ID}, Types: []event.Type{"workspace.setup"}})
			if err != nil || len(setup) != 1 {
				t.Fatalf("setup events=%v %v", setup, err)
			}
			var result struct{ Log event.ID }
			_ = json.Unmarshal(setup[0].Payload, &result)
			log, err := storage.Fetch(ctx, "blob", string(result.Log))
			if err != nil || !strings.Contains(string(log.Body), "Setup diagnostic") {
				t.Fatalf("log=%q %v", log.Body, err)
			}
		})
	}
}
