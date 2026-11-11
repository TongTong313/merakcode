package server_test

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// roster starts an engine and gives back a connection of the person of the machine, the folder of a workspace and a
// way to read a group.
type roster struct {
	t         *testing.T
	client    *protocol.Client
	engine    *engine.Engine
	directory string
}

func newRoster(t *testing.T) *roster {
	t.Helper()
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { instance.Close() })
	return &roster{t: t, client: connectAs(t, instance, protocol.LocalHuman, protocol.Capabilities{}), engine: e, directory: t.TempDir()}
}

func (r *roster) members(extra ...group.Member) []group.Member {
	return append([]group.Member{{ID: protocol.LocalHuman, Name: "You", Kind: group.MemberHuman, Role: group.RoleOwner}}, extra...)
}

func (r *roster) leader(id string) group.Member {
	return group.Member{ID: event.ID(id), Name: id, Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"}
}

func (r *roster) worker(id string) group.Member {
	return group.Member{ID: event.ID(id), Name: id, Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: "builtin-worker"}
}

func (r *roster) create(leader event.ID, directory string, members []group.Member) (group.Group, error) {
	var created group.Group
	err := r.client.Call(r.t.Context(), "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: directory}, Leader: leader}, Members: members}, &created)
	return created, err
}

func (r *roster) state(id event.ID) group.State {
	r.t.Helper()
	state, err := r.engine.Groups.Get(r.t.Context(), id)
	if err != nil {
		r.t.Fatal(err)
	}
	return state
}

func code(err error) string {
	var failure *protocol.Error
	if errors.As(err, &failure) {
		return failure.Data.Code
	}
	return ""
}

func TestTheOldProfileAndRegistrationMethodsAreGoneAndAgentsTakeTheirPlace(t *testing.T) {
	r := newRoster(t)
	for _, method := range []string{"member.register", "member.remove", "profile.list", "profile.save", "profile.delete", "member.test", "member.catalog"} {
		err := r.client.Call(t.Context(), method, struct{}{}, nil)
		var failure *protocol.Error
		if !errors.As(err, &failure) || failure.Code != -32601 {
			t.Errorf("%s: err=%v, want method not found", method, err)
		}
	}
	var agents []agent.Agent
	if err := r.client.Call(t.Context(), "agent.list", struct{}{}, &agents); err != nil || len(agents) < 2 {
		t.Fatalf("agent.list = %d agents, %v", len(agents), err)
	}
	var saved agent.Agent
	draft := agents[0]
	draft.ID, draft.Name = "", "Mine"
	if err := r.client.Call(t.Context(), "agent.save", map[string]any{"agent": draft}, &saved); err != nil || saved.ID == "" {
		t.Fatalf("agent.save = %+v, %v", saved, err)
	}
	if err := r.client.Call(t.Context(), "agent.delete", map[string]any{"agent": saved.ID}, nil); err != nil {
		t.Fatal(err)
	}
	if err := r.client.Call(t.Context(), "agent.catalog", struct{}{}, new([]any)); err != nil {
		t.Fatal(err)
	}
}

func TestAMemberIsAddedByTheIdOfAnExistingAgentAndNeverByAnInlineOne(t *testing.T) {
	r := newRoster(t)
	g, err := r.create("lead", r.directory, r.members(r.leader("lead")))
	if err != nil {
		t.Fatal(err)
	}
	var added group.Member
	if err := r.client.Call(t.Context(), "group.addMember", map[string]any{"group": g.ID, "member": r.worker("helper")}, &added); err != nil || added.Agent != "builtin-worker" {
		t.Fatalf("addMember = %+v, %v", added, err)
	}
	inline := map[string]any{"group": g.ID, "member": r.worker("other"), "agent": agent.DefaultWorker()}
	if err := r.client.Call(t.Context(), "group.addMember", inline, nil); err == nil {
		t.Fatal("an inline agent was accepted")
	}
}

func TestAGroupNeedsExactlyOneLeaderAndAnExistingWorkspace(t *testing.T) {
	r := newRoster(t)
	missing := t.TempDir() + "/does-not-exist"
	for _, test := range []struct {
		name      string
		leader    event.ID
		directory string
		members   []group.Member
		want      string
	}{
		{"no Leader at all", "", r.directory, r.members(r.worker("w")), "MRK-6008"},
		{"two Leaders", "a", r.directory, r.members(r.leader("a"), r.leader("b")), "MRK-6009"},
		{"the Leader is a Worker", "w", r.directory, r.members(r.leader("a"), r.worker("w")), "MRK-6010"},
		{"an empty workspace", "a", "", r.members(r.leader("a")), "MRK-6011"},
		{"a workspace that does not exist", "a", missing, r.members(r.leader("a")), "MRK-6011"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := r.create(test.leader, test.directory, test.members); code(err) != test.want {
				t.Fatalf("code = %q (%v), want %s", code(err), err, test.want)
			}
		})
	}
	if _, err := r.create("a", r.directory, r.members(r.leader("a"), r.worker("w"))); err != nil {
		t.Fatalf("a valid group was refused: %v", err)
	}
}

func TestTheLeaderIsChangedInOneStepAndNeverAddedOrRemovedOnItsOwn(t *testing.T) {
	r := newRoster(t)
	g, err := r.create("lead", r.directory, r.members(r.leader("lead"), r.worker("w")))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.client.Call(t.Context(), "group.addMember", map[string]any{"group": g.ID, "member": r.leader("second")}, nil); code(err) != "MRK-6009" {
		t.Fatalf("a second Leader: code=%q err=%v", code(err), err)
	}
	if err := r.client.Call(t.Context(), "group.removeMember", map[string]any{"group": g.ID, "member": "lead"}, nil); code(err) != "MRK-6012" {
		t.Fatalf("removing the Leader: code=%q err=%v", code(err), err)
	}
	draft := agent.DefaultLeader()
	draft.Name = "Second Leader"
	var next agent.Agent
	if err := r.client.Call(t.Context(), "agent.save", map[string]any{"agent": draft}, &next); err != nil {
		t.Fatal(err)
	}
	if err := r.client.Call(t.Context(), "group.update", map[string]any{"group": g.ID, "leader": "builtin-worker"}, nil); code(err) != "MRK-6010" {
		t.Fatalf("a Worker as Leader: code=%q err=%v", code(err), err)
	}
	var changed group.Group
	if err := r.client.Call(t.Context(), "group.update", map[string]any{"group": g.ID, "leader": next.ID}, &changed); err != nil {
		t.Fatal(err)
	}
	// the former Leader leaves the roster once the handover of its thread is complete
	var state group.State
	var leaders []group.Member
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		state, leaders = r.state(g.ID), nil
		for _, member := range state.Members {
			if member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader {
				leaders = append(leaders, member)
			}
		}
		if len(leaders) == 1 {
			break
		}
	}
	if len(leaders) != 1 || leaders[0].Agent != next.ID || state.Group.Leader != leaders[0].ID || changed.Leader != leaders[0].ID {
		t.Fatalf("roster after the change: leaders=%+v group leader=%q", leaders, state.Group.Leader)
	}
	if slices.ContainsFunc(state.Members, func(member group.Member) bool { return member.ID == "lead" }) {
		t.Fatal("the former Leader is still in the roster")
	}
}

func TestASessionNeedsAnExistingWorkspace(t *testing.T) {
	r := newRoster(t)
	for _, directory := range []string{"", t.TempDir() + "/does-not-exist"} {
		if err := r.client.Call(t.Context(), "session.create", map[string]any{"provider": "fixture", "workdir": directory}, nil); code(err) != "MRK-6011" {
			t.Errorf("workdir %q: code=%q err=%v", directory, code(err), err)
		}
	}
}

func TestOnlyTheOwnerChangesTheLeaderAndTaskThreadsFollowIt(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { instance.Close() })
	owner := connectAs(t, instance, "owner", protocol.Capabilities{})
	admin := connectAs(t, instance, "admin", protocol.Capabilities{})
	directory := t.TempDir()
	var g group.Group
	if err := owner.Call(t.Context(), "group.create", protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "Leaders", Project: group.Project{Directory: directory}}, Members: []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "admin", Name: "Admin", Kind: group.MemberHuman, Role: group.RoleAdmin},
		{ID: "first", Name: "First", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-leader"},
	}}, &g); err != nil {
		t.Fatal(err)
	}
	if g.Leader != "first" {
		t.Fatalf("the Leader of a group with one Leader agent is %q", g.Leader)
	}
	if err := admin.Call(t.Context(), "group.update", map[string]any{"group": g.ID, "leader": "builtin-leader"}, nil); err == nil {
		t.Fatal("an admin changed the Leader")
	}
	var card map[string]any
	if err := owner.Call(t.Context(), "task.create", map[string]any{"group": g.ID, "title": "Goal", "leader": "first"}, &card); err == nil {
		t.Fatal("a task was given a Leader of its own")
	}
	if err := owner.Call(t.Context(), "task.create", map[string]any{"group": g.ID, "title": "Goal"}, &card); err != nil {
		t.Fatal(err)
	}
	if _, has := card["leader"]; has {
		t.Fatalf("the card carries a Leader: %v", card)
	}
	if err := owner.Call(t.Context(), "task.update", map[string]any{"task": card["id"], "leader": "x"}, nil); err == nil {
		t.Fatal("task.update accepted a Leader")
	}
}

func TestATaskCreatedAloneIsBoundToANewOrExistingGroupThroughTheProtocol(t *testing.T) {
	r := newRoster(t)
	elsewhere := t.TempDir()
	var loose, other task.Card
	for title, project := range map[string]string{"Alone": r.directory, "Elsewhere": elsewhere} {
		var card task.Card
		if err := r.client.Call(t.Context(), "task.create", map[string]any{"title": title, "project": project}, &card); err != nil {
			t.Fatal(err)
		}
		if title == "Alone" {
			loose = card
		} else {
			other = card
		}
	}
	if loose.Group != "" || loose.Project != r.directory {
		t.Fatalf("a task made alone: %+v", loose)
	}
	if err := r.client.Call(t.Context(), "task.create", map[string]any{"title": "No project"}, nil); err == nil {
		t.Fatal("a task without a group and a project was created")
	}
	g, err := r.create("lead", r.directory, r.members(r.leader("lead")))
	if err != nil {
		t.Fatal(err)
	}
	var bound task.Card
	if err := r.client.Call(t.Context(), "group.bind", map[string]any{"group": g.ID, "task": loose.ID}, &bound); err != nil || bound.Group != g.ID {
		t.Fatalf("bound=%+v err=%v", bound, err)
	}
	if err := r.client.Call(t.Context(), "group.bind", map[string]any{"group": g.ID, "task": loose.ID}, nil); code(err) != "MRK-6013" {
		t.Fatalf("binding twice: %v", err)
	}
	var created group.Group
	params := protocol.GroupCreateParams{Group: group.Group{Kind: group.KindLocal, Name: "For it", Leader: "lead2"}, Members: r.members(r.leader("lead2")), Task: other.ID}
	if err := r.client.Call(t.Context(), "group.create", params, &created); err != nil || created.Project.Directory != elsewhere {
		t.Fatalf("created=%+v err=%v", created.Project, err)
	}
	var listed []group.Listing
	if err := r.client.Call(t.Context(), "group.list", struct{}{}, &listed); err != nil || len(listed) != 2 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	for _, entry := range listed {
		want := map[event.ID]event.ID{g.ID: loose.ID, created.ID: other.ID}[entry.ID]
		if len(entry.Tasks) != 1 || entry.Tasks[0] != want {
			t.Errorf("group %s lists tasks %v, want %s", entry.ID, entry.Tasks, want)
		}
	}
}

func TestTasksAreListedAndArchivedThroughTheProtocol(t *testing.T) {
	r := newRoster(t)
	var card task.Card
	if err := r.client.Call(t.Context(), "task.create", map[string]any{"title": "Alone", "project": r.directory}, &card); err != nil {
		t.Fatal(err)
	}
	if err := r.client.Call(t.Context(), "task.archive", map[string]any{"tasks": []event.ID{card.ID}, "archived": true}, nil); code(err) != "MRK-6017" {
		t.Fatalf("archiving a running task: %v", err)
	}
	if err := r.client.Call(t.Context(), "task.cancel", map[string]any{"task": card.ID}, new(task.Card)); err != nil {
		t.Fatal(err)
	}
	var archived []task.Card
	if err := r.client.Call(t.Context(), "task.archive", map[string]any{"tasks": []event.ID{card.ID}, "archived": true}, &archived); err != nil || len(archived) != 1 || !archived[0].Archived {
		t.Fatalf("archived=%+v err=%v", archived, err)
	}
	var visible, hidden []task.Card
	if err := r.client.Call(t.Context(), "task.list", map[string]any{"project": r.directory}, &visible); err != nil || len(visible) != 0 {
		t.Fatalf("visible=%+v err=%v", visible, err)
	}
	if err := r.client.Call(t.Context(), "task.list", map[string]any{"archived": true}, &hidden); err != nil || len(hidden) != 1 {
		t.Fatalf("hidden=%+v err=%v", hidden, err)
	}
}
