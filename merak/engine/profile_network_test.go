package engine_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestBuiltinProfileDoesNotAcceptExternalServiceNetworkHosts(t *testing.T) {
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Network = []string{"api.example.com"}
	if _, err := e.SaveProfile(t.Context(), "owner", p); err == nil {
		t.Fatal("builtin profile accepted external service network hosts")
	}
	p.ID = "worker-with-network"
	if _, err := e.CreateGroup(t.Context(), group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID},
	}, []profile.Profile{p}); err == nil {
		t.Error("group accepted a builtin profile with external service network hosts")
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	if run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "invalid-network", Workdir: t.TempDir(), Packet: "Inspect"}); err == nil {
		cancel()
		_ = run.Cancel(t.Context())
		t.Error("worker started with an invalid builtin network profile")
	}
	p.Product = &profile.Product{Kind: worker.KindBuiltin}
	if run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "explicit-builtin-network", Workdir: t.TempDir(), Packet: "Inspect"}); err == nil {
		cancel()
		_ = run.Cancel(t.Context())
		t.Error("explicit builtin product accepted external service network hosts")
	}
}

func TestProfileNetworkHostsPersistWithoutProductDefaults(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, network := range []string{`[]`, `["models.example.com","gateway.example.org"]`} {
		var p profile.Profile
		if err := json.Unmarshal([]byte(`{"name":"External worker","role":"worker","toolPool":"worker.default","product":{"kind":"codex","binary":"codex"},"network":`+network+`}`), &p); err != nil {
			t.Fatal(err)
		}
		saved, err := e.SaveProfile(ctx, "owner", p)
		if err != nil {
			t.Fatal(err)
		}
		profiles, err := e.ListProfiles(ctx, "owner")
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, loaded := range profiles {
			if loaded.ID != saved.ID {
				continue
			}
			found = true
			data, err := json.Marshal(loaded)
			if err != nil {
				t.Fatal(err)
			}
			var view struct{ Network []string }
			var want []string
			if err := json.Unmarshal(data, &view); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(network), &want); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(view.Network, want) {
				t.Fatalf("profile network = %v, want %v", view.Network, want)
			}
		}
		if !found {
			t.Fatal("saved profile is missing")
		}
	}
}

func TestProfileRejectsInvalidNetworkHosts(t *testing.T) {
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	for _, host := range []string{"https://models.example.com", "models.example.com:65536", "models.*.com", "*", "", "example.com/path"} {
		t.Run(host, func(t *testing.T) {
			p := profile.DefaultWorker()
			p.Product = &profile.Product{Kind: worker.KindCommand, Binary: "fixture"}
			p.Network = []string{host}
			if _, err := e.SaveProfile(context.Background(), "owner", p); err == nil {
				t.Fatalf("saved invalid network host %q", host)
			}
		})
	}
}

func TestAdminAcceptsTheProfileHostsWhenRegisteringAMember(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := profile.DefaultWorker()
	p.Network = []string{"models.example.com"}
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: "fixture"}
	p, err = e.SaveProfile(ctx, "owner", p)
	if err != nil {
		t.Fatal(err)
	}
	member, err := e.RegisterMember(ctx, g.ID, "owner", group.Member{Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID})
	if err != nil {
		t.Fatal(err)
	}
	p.Network = append(p.Network, "new.example.org")
	if _, err := e.SaveProfile(ctx, "owner", p); err != nil {
		t.Fatal(err)
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, saved := range state.Members {
		if saved.ID != member.ID {
			continue
		}
		data, err := json.Marshal(saved)
		if err != nil {
			t.Fatal(err)
		}
		var view struct{ Hosts []string }
		if err := json.Unmarshal(data, &view); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(view.Hosts, []string{"models.example.com"}) {
			t.Fatalf("accepted member hosts = %v, want only the original profile host", view.Hosts)
		}
		return
	}
	t.Fatal("registered member is missing")
}

func TestGroupMemberHostsComeFromTheAcceptedProfile(t *testing.T) {
	ctx := context.Background()
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.ID, p.Network = "profile", []string{"models.example.com"}
	p.Product = &profile.Product{Kind: worker.KindCommand, Binary: "fixture"}
	g, err := e.CreateGroup(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Profile: "builtin-leader"},
		{ID: "initial", Name: "Initial worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID, Hosts: []string{"injected.example"}},
	}, []profile.Profile{p})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.AddGroupMember(ctx, g.ID, group.Member{ID: "added", Name: "Added worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: p.ID, Hosts: []string{"injected.example"}}, nil); err != nil {
		t.Fatal(err)
	}
	state, err := e.Groups.Get(ctx, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range state.Members {
		if member.ID == "initial" || member.ID == "added" {
			if !slices.Equal(member.Hosts, []string{"models.example.com"}) {
				t.Errorf("member %s accepted %v, want only the profile host", member.ID, member.Hosts)
			}
		}
	}
}
