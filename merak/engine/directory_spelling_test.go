package engine_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

// otherSpellings are ways to write the same folder that must not make it a different one.
func otherSpellings(dir string) []string {
	return []string{filepath.ToSlash(dir) + "/", dir + string(filepath.Separator), filepath.Join(dir, "sub", "..")}
}

func TestADirectoryWrittenInAnotherWayIsTheSameWorkspaceEverywhere(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	lead := agent.DefaultMerakCode()
	lead.ID, lead.Model.Provider = "lead-agent", "fake"
	spelled := otherSpellings(dir)[0]
	g, err := createGroup(t, e, ctx, group.Group{Kind: group.KindLocal, Name: "Spelling", Project: group.Project{Directory: spelled}, Leader: "leader"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: lead.ID},
	}, []agent.Agent{lead})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := workspace.Canonical(dir)
	if err != nil {
		t.Fatal(err)
	}
	if g.Project.Directory != canonical {
		t.Fatalf("the group stores %q, want %q", g.Project.Directory, canonical)
	}
	for _, spelling := range append(otherSpellings(dir), dir) {
		files, err := e.ListFiles(ctx, spelling, ".")
		if err != nil || len(files) == 0 {
			t.Errorf("file.list for %q: %+v %v", spelling, files, err)
		}
		card, err := e.CreateTask(ctx, task.Card{Project: spelling, Title: "Loose " + spelling, CreatedBy: event.Actor{Kind: event.ActorHuman, ID: "owner"}})
		if err != nil || card.Project != canonical {
			t.Errorf("a task made for %q is in %q, %v", spelling, card.Project, err)
		}
		if tasks, err := e.ListTasks(ctx, task.Filter{Project: spelling}); err != nil || len(tasks) == 0 {
			t.Errorf("task.list for %q: %d %v", spelling, len(tasks), err)
		}
		id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fake", Workdir: spelling})
		if err != nil {
			t.Fatal(err)
		}
		state, err := e.SessionSnapshot(ctx, id)
		if err != nil || state.Config.Workdir != canonical {
			t.Errorf("a session for %q works in %q, %v", spelling, state.Config.Workdir, err)
		}
	}
	listed, err := e.Board.Groups(ctx, "owner")
	if err != nil || len(listed) != 1 || listed[0].Project.Directory != canonical {
		t.Fatalf("group.list shows %+v, %v", listed, err)
	}
}
