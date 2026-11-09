package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestEngineSandboxBuiltinCannotReadProductState(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	secret := filepath.Join(home, ".codex", "auth.json")
	if err := os.MkdirAll(filepath.Dir(secret), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("product credential"), 0600); err != nil {
		t.Fatal(err)
	}
	input, _ := json.Marshal(map[string]string{"command": fmt.Sprintf("IFS= read -r value < %q", secret)})
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "read", Name: "bash", Input: input}}}, fake.Reply{Text: "finished"})
	e, err := engine.New(engine.Deps{Workdir: workspace, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		return permission.Reply{Decision: permission.Allow}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	if _, err := e.Chat(t.Context(), "fixture", "Read the file"); err != nil {
		t.Fatal(err)
	}
	facts, err := e.FindEvents(t.Context(), store.Query{Types: []event.Type{tool.Completed}, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		completion, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		if completion.Name == "bash" && completion.IsError && completion.Code == "MRK-5009" {
			return
		}
	}
	t.Fatalf("missing builtin product credential denial: path=%s", secret)
}

func init() {
	if len(os.Args) == 4 && os.Args[1] == "--merak-engine-private-data-fixture" {
		if _, err := os.ReadFile(os.Args[2]); !os.IsPermission(err) {
			os.Exit(26)
		}
		if err := os.WriteFile(os.Args[3], []byte("data denied"), 0600); err != nil {
			os.Exit(27)
		}
		fmt.Print("data denied")
		os.Exit(0)
	}
	if len(os.Args) < 3 || len(os.Args) > 4 || os.Args[1] != "--merak-engine-network-fixture" {
		return
	}
	address, err := url.Parse(os.Getenv("HTTP_PROXY"))
	if err != nil || address.Scheme != "http" || address.Host == "" {
		os.Exit(2)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(address)}, Timeout: 5 * time.Second}
	count := 1
	if len(os.Args) == 4 {
		count, err = strconv.Atoi(os.Args[3])
		if err != nil || count < 1 {
			os.Exit(5)
		}
	}
	for range count {
		response, err := client.Get(os.Args[2])
		if err != nil {
			os.Exit(3)
		}
		_, _ = io.Copy(os.Stdout, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(4)
		}
	}
	os.Exit(0)
}

func TestEngineSandboxDeniesItsOwnDataDirectory(t *testing.T) {
	data, workspace := t.TempDir(), t.TempDir()
	secret := filepath.Join(data, "merakcode.json")
	if err := os.WriteFile(secret, []byte("engine-only data"), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{DataDir: data, Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	marker := filepath.Join(workspace, "completed")
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-private-data-fixture", secret, marker}}
	run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: event.NewID(), Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(t.Context()); err != nil {
		t.Fatalf("engine data path=%s error=%v", secret, err)
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "data denied" {
		t.Fatalf("engine data was readable: marker=%q error=%v", body, err)
	}
}

func TestEngineSandboxAsksBeforeNonforwardingStartupWhenNetworkIsUnenforced(t *testing.T) {
	workspace := t.TempDir()
	status := new(sandbox.Launcher).Status(t.Context(), sandbox.Profile{})
	if !status.Available {
		t.Fatalf("file isolation unavailable: %+v", status)
	}
	var asked atomic.Int32
	e, err := engine.New(engine.Deps{Workdir: workspace, Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		asked.Add(1)
		if request.Kind != "launch" || !strings.Contains(request.Spec.Description, "Network restrictions are not enforced; file restrictions remain active.") {
			t.Errorf("incorrect network-only approval: %+v", request)
		}
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-protection-event-fixture", filepath.Join(workspace, "output")}}
	run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: "network-enforcement", Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	_, err = run.Wait(t.Context())
	if status.Network == "none" {
		if err == nil || !strings.Contains(err.Error(), "MRK-5006") || asked.Load() != 1 {
			t.Fatalf("unrestricted network launch: asks=%d error=%v", asked.Load(), err)
		}
		if _, err := os.Stat(filepath.Join(workspace, "output")); !os.IsNotExist(err) {
			t.Fatalf("denied member started: %v", err)
		}
		return
	}
	if err != nil || asked.Load() != 0 {
		t.Fatalf("enforced network launch: asks=%d error=%v", asked.Load(), err)
	}
}

func TestEngineSandboxMergesUserAndGroupNetworkDenials(t *testing.T) {
	for _, test := range []struct {
		name, source      string
		grouped, userDeny bool
	}{
		{"user in single chat", "user", false, true},
		{"user in group", "user", true, true},
		{"group denial", "group", true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			settings := config.NewMemory()
			if test.userDeny {
				denials := []string{"blocked.example:443"}
				if _, err := settings.Update(config.Patch{DeniedHosts: &denials}); err != nil {
					t.Fatal(err)
				}
			}
			var asked atomic.Int32
			e, err := engine.New(engine.Deps{NetworkSettings: settings, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
				asked.Add(1)
				return permission.Reply{Decision: permission.Deny}, nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			p := profile.DefaultWorker()
			p.ID, p.Name = "network-member", "Network member"
			p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", "http://blocked.example:443/"}}
			a := worker.Assignment{Session: event.NewID(), Workdir: t.TempDir()}
			if test.grouped {
				groupSettings := group.Settings{}
				if !test.userDeny {
					groupSettings.DeniedHosts = []string{"blocked.example:443"}
				}
				g, err := e.CreateGroup(t.Context(), group.Group{Kind: group.KindLocal, Name: "Network", Project: group.Project{Directory: a.Workdir}, DefaultLeader: "leader", Settings: groupSettings}, []group.Member{
					{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
					{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
					{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
				}, []profile.Profile{p})
				if err != nil {
					t.Fatal(err)
				}
				a.Scope.Group, a.Claim.Member = g.ID, "worker"
			}
			run, err := e.StartWorker(t.Context(), p, a)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := run.Wait(t.Context()); err == nil {
				t.Fatal("denied network call succeeded")
			}
			if asked.Load() != 0 {
				t.Fatalf("explicit network denial asked %d times", asked.Load())
			}
			for fact := range run.Events() {
				if fact.Type != tool.Completed {
					continue
				}
				completion, err := event.Decode[tool.Completion](fact)
				if err != nil {
					t.Fatal(err)
				}
				if completion.Code != "MRK-5005" || completion.DeniedHost != "blocked.example" || completion.MemberName != p.Name {
					continue
				}
				for _, part := range completion.Parts {
					if strings.Contains(part.Text, test.source+" DeniedHosts") {
						return
					}
				}
			}
			t.Fatal("missing the denial source in tool.completed")
		})
	}
}

func TestEngineSandboxGroupRequiresApprovalForProfileNetworkChanges(t *testing.T) {
	if runInPublicNetwork(t) {
		return
	}
	localNetworkDNS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	target := publicNetworkServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "model response") }))
	defer target.Close()
	port := target.Listener.Addr().(*net.TCPAddr).Port
	asked := make(chan permission.Request, 4)
	e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		asked <- request
		return permission.Reply{Decision: permission.Allow, Human: "approver"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader", Settings: group.Settings{AllowedHosts: []string{"shared.example"}}}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := profile.DefaultWorker()
	p.Network = []string{"original.example"}
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0]}
	p, err = e.SaveProfile(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	member, err := e.RegisterMember(ctx, g.ID, "owner", group.Member{Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID})
	if err != nil {
		t.Fatal(err)
	}
	p.Network = append(p.Network, "added.example")
	p, err = e.SaveProfile(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"original.example", "shared.example", "added.example"} {
		t.Run(host, func(t *testing.T) {
			p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", fmt.Sprintf("http://%s:%d/", host, port)}}
			a := worker.Assignment{Session: event.ID(host), Workdir: g.Project.Directory, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: member.ID}, SandboxProfile: sandbox.Profile{Network: sandbox.Network{LocalPorts: []int{port}}}}
			run, err := e.StartWorker(ctx, p, a)
			if err != nil {
				t.Fatal(err)
			}
			report, runErr := run.Wait(ctx)
			if host == "added.example" {
				if runErr == nil || report.Verdict == task.VerdictDone {
					t.Fatalf("profile expansion bypassed admin approval: %+v %v", report, runErr)
				}
				select {
				case request := <-asked:
					if request.Host != host {
						t.Fatalf("approval host = %s", request.Host)
					}
				default:
					t.Fatal("new profile host did not request admin approval")
				}
				return
			}
			if runErr != nil || report.Summary != "model response" {
				t.Errorf("accepted host failed: %+v %v", report, runErr)
			}
			select {
			case request := <-asked:
				t.Errorf("accepted host required approval: %s", request.Host)
			default:
			}
		})
	}
}

func localNetworkDNS(t *testing.T) {
	t.Helper()
	server, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 4096)
		for {
			n, peer, err := server.ReadFrom(buffer)
			if err != nil {
				return
			}
			query := buffer[:n]
			if len(query) < 13 {
				continue
			}
			end := 12
			for end < len(query) && query[end] != 0 {
				end += 1 + int(query[end])
			}
			end += 5
			if end > len(query) {
				continue
			}
			answer := append([]byte(nil), query[:end]...)
			answer[2], answer[3] = 0x81, 0x80
			for i := 6; i < 12; i++ {
				answer[i] = 0
			}
			if query[end-4] == 0 && query[end-3] == 1 {
				answer[7] = 1
				answer = append(answer, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 1, 1, 1)
			}
			_, _ = server.WriteTo(answer, peer)
		}
	}()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.LocalAddr().String())
	}}
	t.Cleanup(func() { net.DefaultResolver = previous; _ = server.Close(); <-done })
}

func TestEngineSandboxNetworkApprovalPersistsInGroupSettings(t *testing.T) {
	if runInPublicNetwork(t) {
		return
	}
	localNetworkDNS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	target := publicNetworkServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "approved response") }))
	defer target.Close()
	port := target.Listener.Addr().(*net.TCPAddr).Port
	var approvals atomic.Int32
	e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		approvals.Add(1)
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.ID = "external-profile"
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", fmt.Sprintf("http://approved.example:%d/", port), "2"}}
	p, err = e.SaveProfile(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
		{ID: "member", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p.Network = []string{"approved.example"}
	p, err = e.SaveProfile(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		a := worker.Assignment{Session: event.ID(fmt.Sprintf("network-%d", i)), Workdir: g.Project.Directory, Scope: event.Scope{Group: g.ID}, Claim: task.Claim{Member: "member"}, SandboxProfile: sandbox.Profile{Network: sandbox.Network{LocalPorts: []int{port}}}}
		run, err := e.StartWorker(ctx, p, a)
		if err != nil {
			t.Fatal(err)
		}
		report, err := run.Wait(ctx)
		if err != nil || report.Summary != "approved responseapproved response" {
			t.Fatalf("approved network: %+v %v", report, err)
		}
		state, err := e.Groups.Get(ctx, g.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(state.Group.Settings.AllowedHosts, "approved.example") {
			t.Fatal("approved host was not saved in group settings")
		}
		accepted := false
		for _, member := range state.Members {
			if member.ID == "member" {
				accepted = slices.Equal(member.Hosts, []string{"approved.example"})
			}
		}
		if !accepted {
			t.Error("approved profile host was not saved in the member record")
		}
		if approvals.Load() != 1 {
			t.Fatalf("approved host required %d approvals", approvals.Load())
		}
	}
}

func TestEngineSandboxSingleChatRemembersNetworkHostsAfterRestart(t *testing.T) {
	if runInPublicNetwork(t) {
		return
	}
	localNetworkDNS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	target := publicNetworkServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "saved response") }))
	defer target.Close()
	port := target.Listener.Addr().(*net.TCPAddr).Port
	path := filepath.Join(t.TempDir(), "merakcode.json")
	var approvals atomic.Int32
	for range 2 {
		settings, err := config.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		e, err := engine.New(engine.Deps{NetworkSettings: settings, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			approvals.Add(1)
			return permission.Reply{Decision: permission.Allow}, nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		p := profile.DefaultWorker()
		p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", fmt.Sprintf("http://remembered.example:%d/", port)}}
		run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "single-chat", Workdir: t.TempDir(), SandboxProfile: sandbox.Profile{Network: sandbox.Network{LocalPorts: []int{port}}}})
		if err != nil {
			_ = e.Close()
			t.Fatal(err)
		}
		report, err := run.Wait(ctx)
		closeErr := e.Close()
		if err != nil || closeErr != nil || report.Summary != "saved response" {
			t.Fatalf("single-chat network: %+v %v %v", report, err, closeErr)
		}
		if approvals.Load() != 1 {
			t.Fatalf("remembered host required %d approvals", approvals.Load())
		}
	}
}

func TestEngineSandboxSingleChatAllowAllStillEnforcesUserDenials(t *testing.T) {
	if runInPublicNetwork(t) {
		return
	}
	localNetworkDNS(t)
	target := publicNetworkServer(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "allowed response") }))
	defer target.Close()
	port := target.Listener.Addr().(*net.TCPAddr).Port
	settings := config.NewMemory()
	allowed, denied := []string{"*"}, []string{"blocked.example"}
	if _, err := settings.Update(config.Patch{AllowedHosts: &allowed, DeniedHosts: &denied}); err != nil {
		t.Fatal(err)
	}
	var asked atomic.Int32
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		asked.Add(1)
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, host := range []string{"unlisted.example", "blocked.example"} {
		p := profile.DefaultWorker()
		p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", fmt.Sprintf("http://%s:%d/", host, port)}}
		run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: event.NewID(), Workdir: t.TempDir(), SandboxProfile: sandbox.Profile{Network: sandbox.Network{LocalPorts: []int{port}}}})
		if err != nil {
			t.Fatal(err)
		}
		report, err := run.Wait(t.Context())
		if host == "unlisted.example" && (err != nil || report.Summary != "allowed response") {
			t.Fatalf("allow-all request=%+v %v", report, err)
		}
		if host == "blocked.example" && err == nil {
			t.Fatal("allow-all bypassed user denial")
		}
	}
	if asked.Load() != 0 {
		t.Fatalf("allow-all and explicit denial requested %d approvals", asked.Load())
	}
}

func TestEngineSandboxKeepsLateNetworkApprovalAfterTheWorkerExits(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	settings, err := config.Open(filepath.Join(t.TempDir(), "merakcode.json"))
	if err != nil {
		t.Fatal(err)
	}
	asked := make(chan context.Context, 1)
	answer := make(chan permission.Reply, 1)
	e, err := engine.New(engine.Deps{NetworkSettings: settings, Ask: func(ctx context.Context, _ permission.Request) (permission.Reply, error) {
		asked <- ctx
		select {
		case reply := <-answer:
			return reply, nil
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", "http://late.example/"}}
	facts, stop := e.Bus.Subscribe(event.Filter{Types: []event.Type{permission.Replied}})
	defer stop()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "late", Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var approvalContext context.Context
	select {
	case approvalContext = <-asked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if report, err := run.Wait(ctx); err == nil || report.Verdict == task.VerdictDone {
		t.Fatalf("unanswered connection should time out: %+v %v", report, err)
	}
	completed, err := e.ReadEvents(ctx, "session:late", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	denied := false
	for _, fact := range completed {
		if fact.Type != tool.Completed {
			continue
		}
		result, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		denied = denied || result.IsError && result.Code == "MRK-5005" && result.DeniedHost == "late.example"
	}
	if !denied {
		t.Fatal("timed-out connection has no coded error while approval is open")
	}
	select {
	case <-approvalContext.Done():
		t.Fatal("worker exit closed the unanswered network approval")
	case <-time.After(100 * time.Millisecond):
	}
	answer <- permission.Reply{Decision: permission.Allow}
	select {
	case <-facts:
	case <-ctx.Done():
		t.Fatal("late approval never completed")
	}
	if !slices.Contains(settings.AllowedNetworkHosts(), "late.example") {
		t.Fatal("late approval was not saved for the next connection")
	}
}

func TestEngineSandboxExternalNetworkAsksBeforeConnecting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	asked := make(chan permission.Request, 1)
	e, err := engine.New(engine.Deps{Ask: func(_ context.Context, request permission.Request) (permission.Reply, error) {
		asked <- request
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.ID, p.Name = "external-profile", "External member"
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-engine-network-fixture", "http://unlisted.example.com/"}}
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "network", Workdir: t.TempDir(), Claim: task.Claim{Member: "member"}})
	if err != nil {
		t.Fatal(err)
	}
	report, runErr := run.Wait(ctx)
	if runErr == nil || report.Verdict == task.VerdictDone {
		t.Fatalf("unapproved network request succeeded: %+v %v", report, runErr)
	}
	select {
	case request := <-asked:
		if request.Host != "unlisted.example.com" || request.Kind != "network" || request.Call.Env.Scope.Session != "network" {
			t.Fatalf("network approval = %s", fmt.Sprint(request))
		}
	default:
		t.Fatalf("external member never requested approval: %+v %v", report, runErr)
	}
	facts, err := e.ReadEvents(ctx, "session:network", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, fact := range facts {
		if fact.Type != tool.Completed {
			continue
		}
		completion, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		if completion.Name == "sandbox_network" && completion.Code == "MRK-5005" && completion.IsError {
			var details struct {
				DeniedHost string
				MemberName string
			}
			if err := json.Unmarshal(fact.Payload, &details); err != nil {
				t.Fatal(err)
			}
			if details.DeniedHost != "unlisted.example.com" || details.MemberName != "External member" {
				t.Fatalf("network error details = %+v", details)
			}
			return
		}
	}
	t.Fatal("network refusal did not emit a coded tool.completed error")
}
