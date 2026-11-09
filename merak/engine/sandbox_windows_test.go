package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
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
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

func init() {
	if len(os.Args) == 3 && os.Args[1] == "--merak-engine-environment-fixture" {
		body, _ := json.Marshal(map[string]string{"path": os.Getenv("PATH"), "private": os.Getenv("MERAKCODE_ENV_PRIVATE_FIXTURE"), "explicit": os.Getenv("MERAKCODE_ENV_EXPLICIT_FIXTURE")})
		if err := os.WriteFile(os.Args[2], body, 0600); err != nil {
			os.Exit(2)
		}
		fmt.Print("environment checked")
		os.Exit(0)
	}
	if len(os.Args) == 3 && os.Args[1] == "--merak-engine-launch-fixture" {
		if err := os.WriteFile(os.Args[2], []byte("started"), 0o600); err != nil {
			os.Exit(2)
		}
		fmt.Print("started")
		os.Exit(0)
	}
}

func TestUnavailableSandboxKeepsCommandSearchPathAndExplicitMemberEnvironment(t *testing.T) {
	workspace := t.TempDir()
	t.Setenv("MERAKCODE_ENV_PRIVATE_FIXTURE", "must-not-reach-member")
	e, err := engine.New(engine.Deps{Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	output := filepath.Join(workspace, "environment.json")
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-environment-fixture", output}, Env: map[string]string{"MERAKCODE_ENV_EXPLICIT_FIXTURE": "configured"}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "environment", Workdir: workspace, Packet: "Inspect"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var environment map[string]string
	if err := json.Unmarshal(body, &environment); err != nil {
		t.Fatal(err)
	}
	if environment["path"] != os.Getenv("PATH") || environment["path"] == "" {
		t.Error("member lost the command search path")
	}
	if environment["private"] != "" {
		t.Error("member inherited an unapproved environment variable")
	}
	if environment["explicit"] != "configured" {
		t.Error("member lost its explicitly configured environment")
	}
}

func TestUnavailableSandboxLeaderSeesTheMemberRisk(t *testing.T) {
	workspace := t.TempDir()
	requests := make(chan model.Request, 1)
	provider := fake.New(t, fake.Reply{Text: "Observed", Expect: func(request model.Request) error { requests <- request; return nil }})
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Deny, Human: "owner"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	lead, work := profile.DefaultLeader(), profile.DefaultWorker()
	lead.ID, lead.Model.Provider, work.ID = "leader-profile", "fixture", "worker-profile"
	work.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-launch-fixture", filepath.Join(workspace, "started.txt")}}
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Member risk", Project: group.Project{Directory: workspace}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: lead.ID},
		{ID: "unconfined-worker", Name: "Command", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: work.ID},
	}, []profile.Profile{lead, work})
	if err != nil {
		t.Fatal(err)
	}
	run, err := e.StartWorker(ctx, work, worker.Assignment{Session: "startup", Workdir: workspace, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: "unconfined-worker"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err == nil {
		t.Fatal("denied member started")
	}
	if _, err := e.CreateTask(ctx, task.Card{Group: g.ID, Title: "Choose a member for sensitive work", CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case request := <-requests:
		body, err := json.Marshal(request.Messages)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), "unconfined-worker") || !strings.Contains(string(body), "unconfined") || !strings.Contains(string(body), "Avoid assigning sensitive tasks to unconfined members") {
			t.Fatalf("leader did not receive the member risk: %s", body)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestUnavailableSandboxRemembersStartupDecisionByMemberAndProject(t *testing.T) {
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			configPath := filepath.Join(t.TempDir(), "config.json")
			workspace := t.TempDir()
			var asked atomic.Int32
			for index, current := range []struct {
				member    string
				workdir   string
				approvals int32
			}{
				{"first", workspace, 1}, {"first", workspace, 1}, {"second", workspace, 2}, {"first", t.TempDir(), 3},
			} {
				settings, err := config.Open(configPath)
				if err != nil {
					t.Fatal(err)
				}
				e, err := engine.New(engine.Deps{NetworkSettings: settings, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
					asked.Add(1)
					var reply permission.Reply
					if err := json.Unmarshal([]byte(fmt.Sprintf(`{"decision":%q,"remember":"always"}`, decision)), &reply); err != nil {
						t.Error(err)
					}
					return reply, nil
				}})
				if err != nil {
					t.Fatal(err)
				}
				marker := filepath.Join(current.workdir, fmt.Sprintf("run-%d.txt", index))
				p := profile.DefaultWorker()
				p.ID = event.ID(current.member)
				p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-launch-fixture", marker}}
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "launch", Workdir: current.workdir})
				if err != nil {
					t.Fatal(err)
				}
				_, runErr := run.Wait(ctx)
				cancel()
				if err := e.Close(); err != nil {
					t.Fatal(err)
				}
				if asked.Load() != current.approvals {
					t.Errorf("run %d approvals=%d, want %d", index, asked.Load(), current.approvals)
				}
				_, fileErr := os.Stat(marker)
				if decision == permission.Allow && (runErr != nil || fileErr != nil) || decision == permission.Deny && (runErr == nil || !os.IsNotExist(fileErr)) {
					t.Errorf("run %d decision=%s run=%v marker=%v", index, decision, runErr, fileErr)
				}
			}
		})
	}
}

func TestUnavailableSandboxSessionChoiceDoesNotAuthorizeAnotherSession(t *testing.T) {
	workspace := t.TempDir()
	var asked atomic.Int32
	e, err := engine.New(engine.Deps{Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		asked.Add(1)
		return permission.Reply{Decision: permission.Allow, Remember: "session"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.ID = "command-profile"
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-launch-fixture", filepath.Join(workspace, "started.txt")}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for index, id := range []event.ID{"first", "first", "second"} {
		run, err := e.StartWorker(ctx, p, worker.Assignment{Session: id, Workdir: workspace})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := run.Wait(ctx); err != nil {
			t.Fatal(err)
		}
		want := int32(1)
		if index == 2 {
			want = 2
		}
		if asked.Load() != want {
			t.Errorf("run %d asked=%d, want %d", index, asked.Load(), want)
		}
	}
}

func TestUnavailableSandboxGroupStartupRequiresAdmin(t *testing.T) {
	for _, human := range []event.ID{"approver", "leader", "admin", "owner"} {
		t.Run(string(human), func(t *testing.T) {
			workspace := t.TempDir()
			marker := filepath.Join(workspace, "started.txt")
			var asked atomic.Int32
			e, err := engine.New(engine.Deps{Ask: func(context.Context, permission.Request) (permission.Reply, error) {
				asked.Add(1)
				return permission.Reply{Decision: permission.Allow, Human: human, Remember: "always"}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Launch approval", Project: group.Project{Directory: workspace}, DefaultLeader: "leader"}, []group.Member{
				{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
				{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
				{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
				{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			p := profile.DefaultWorker()
			p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-launch-fixture", marker}}
			p, err = e.SaveProfile(ctx, "owner", p)
			if err != nil {
				t.Fatal(err)
			}
			member, err := e.RegisterMember(ctx, g.ID, "owner", group.Member{Name: "Command", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID})
			if err != nil {
				t.Fatal(err)
			}
			run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "launch", Workdir: workspace, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: member.ID}})
			if err != nil {
				t.Fatal(err)
			}
			_, runErr := run.Wait(ctx)
			state, err := e.Groups.Get(ctx, g.ID)
			if err != nil {
				t.Fatal(err)
			}
			marked := false
			for _, current := range state.Members {
				if current.ID != member.ID {
					continue
				}
				body, err := json.Marshal(current)
				if err != nil {
					t.Fatal(err)
				}
				var status struct {
					Unconfined bool `json:"unconfined"`
				}
				if err := json.Unmarshal(body, &status); err != nil {
					t.Fatal(err)
				}
				marked = status.Unconfined
			}
			if !marked {
				t.Error("member did not report unrestricted local execution")
			}
			_, fileErr := os.Stat(marker)
			allowed := human == "admin" || human == "owner"
			if allowed && (runErr != nil || fileErr != nil) || !allowed && (runErr == nil || !os.IsNotExist(fileErr)) {
				t.Errorf("startup allowed=%v run=%v marker=%v", allowed, runErr, fileErr)
			}
			facts, err := e.ReadEvents(ctx, event.Stream("group:"+g.ID), 1, 100)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, fact := range facts {
				if fact.Type != group.NoticeSent {
					continue
				}
				notice, err := event.Decode[group.Notice](fact)
				if err != nil {
					t.Fatal(err)
				}
				if notice.Kind != "permission" {
					continue
				}
				found = true
				if len(notice.To) != 2 || !slices.Contains(notice.To, "admin") || !slices.Contains(notice.To, "owner") {
					t.Errorf("unrestricted startup recipients = %v", notice.To)
				}
			}
			if !found {
				t.Error("startup approval did not notify admin")
			}
			if allowed {
				nextWorkspace := t.TempDir()
				p.Product.Args = []string{"--merak-engine-launch-fixture", filepath.Join(nextWorkspace, "started.txt")}
				next, err := e.StartWorker(ctx, p, worker.Assignment{Session: "next-claim", Workdir: nextWorkspace, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: member.ID}})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := next.Wait(ctx); err != nil {
					t.Fatal(err)
				}
				if asked.Load() != 1 {
					t.Errorf("same project with another claim workspace asked %d times", asked.Load())
				}
			} else {
				human = "owner"
				next, err := e.StartWorker(ctx, p, worker.Assignment{Session: "qualified-retry", Workdir: workspace, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: member.ID}})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := next.Wait(ctx); err != nil {
					t.Errorf("unqualified reply prevented owner approval: %v", err)
				}
				if asked.Load() != 2 {
					t.Errorf("unqualified reply was remembered: %d approvals", asked.Load())
				}
			}
		})
	}
}

func TestUnavailableSandboxAsksBeforeStartingAnUnconfinedMember(t *testing.T) {
	workspace := t.TempDir()
	marker := filepath.Join(workspace, "started.txt")
	var asked atomic.Int32
	e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		var input struct {
			Member     string `json:"member"`
			Reason     string `json:"reason"`
			Unconfined bool   `json:"unconfined"`
		}
		if err := json.Unmarshal(request.Call.Input, &input); err != nil {
			t.Error(err)
		}
		if request.Kind != "launch" || input.Member != "Command member" || input.Reason == "" || !input.Unconfined {
			t.Errorf("startup request did not describe the unrestricted member: %+v %+v", request, input)
		}
		asked.Add(1)
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Name = "Command member"
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-launch-fixture", marker}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "unconfined", Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	_, runErr := run.Wait(ctx)
	if asked.Load() != 1 || runErr == nil {
		t.Errorf("startup approvals = %d, error = %v", asked.Load(), runErr)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Errorf("denied member executed: %v", err)
	}
	facts, err := e.ReadEvents(ctx, "session:unconfined", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, fact := range facts {
		if fact.Type == tool.Completed {
			completed, err := event.Decode[tool.Completion](fact)
			if err == nil && completed.Result.IsError && completed.Result.Code == "MRK-5006" {
				found = true
			}
		}
	}
	if !found {
		t.Error("denied startup did not complete with MRK-5006")
	}
}
