package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

func TestGroupAndTaskCommandsUseTheRunningEngine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	body, _ := json.Marshal(map[string]any{"kind": "local", "name": "CLI group", "project": map[string]string{"directory": home}, "leader": "leader", "members": []map[string]string{{"id": "leader", "kind": "agent", "name": "Leader", "agentRole": "leader", "agent": "builtin-merakcode"}, {"id": "local-human", "kind": "human", "name": "Owner", "role": "owner"}}})
	path := filepath.Join(home, "group-input.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := Run([]string{"group", "create", "--file", path}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("create=%d %s", code, &out)
	}
	var g group.Group
	if err := json.Unmarshal(out.Bytes(), &g); err != nil || g.Name != "CLI group" {
		t.Fatalf("group=%+v %v", g, err)
	}
	for _, args := range [][]string{
		{"task", "create", "--group", string(g.ID), "--title", "CLI task", "--workspace", "none"},
		{"group", "board", "--group", string(g.ID)},
		{"agent", "catalog"},
	} {
		out.Reset()
		if code := Run(args, strings.NewReader(""), &out); code != 0 || !json.Valid(bytes.TrimSpace(out.Bytes())) {
			t.Fatalf("%v=%d %s", args, code, &out)
		}
	}
	notice, _ := json.Marshal(group.Notice{Kind: "question", To: []event.ID{"local-human"}, Text: "Choose target"})
	if _, err := e.Bus.Publish(t.Context(), event.Event{Stream: event.Stream("group:" + g.ID), Scope: event.Scope{Group: g.ID}, Type: group.NoticeSent, Payload: notice}); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := Run([]string{"group", "inbox", "--group", string(g.ID)}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), "Choose target") {
		t.Fatalf("inbox=%d %s", code, &out)
	}
}

func TestTaskCommandsCreateListBindAndArchiveTasks(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	run := func(args ...string) []byte {
		t.Helper()
		var out bytes.Buffer
		if code := Run(args, strings.NewReader(""), &out); code != 0 || !json.Valid(bytes.TrimSpace(out.Bytes())) {
			t.Fatalf("%v=%d %s", args, code, &out)
		}
		return out.Bytes()
	}
	var alone, other struct{ ID, Group, Project string }
	if err := json.Unmarshal(run("task", "create", "--title", "Alone", "--project", home), &alone); err != nil || alone.ID == "" || alone.Group != "" || alone.Project != home {
		t.Fatalf("alone=%+v %v", alone, err)
	}
	elsewhere := t.TempDir()
	if err := json.Unmarshal(run("task", "create", "--title", "Elsewhere", "--project", elsewhere), &other); err != nil {
		t.Fatal(err)
	}
	var listed []struct{ ID string }
	if err := json.Unmarshal(run("task", "list", "--project", elsewhere), &listed); err != nil || len(listed) != 1 || listed[0].ID != other.ID {
		t.Fatalf("listed=%+v %v", listed, err)
	}
	body, _ := json.Marshal(map[string]any{"kind": "local", "name": "CLI group", "project": map[string]string{"directory": home}, "leader": "leader", "members": []map[string]string{{"id": "leader", "kind": "agent", "name": "Leader", "agentRole": "leader", "agent": "builtin-merakcode"}, {"id": "local-human", "kind": "human", "name": "Owner", "role": "owner"}}})
	path := filepath.Join(home, "group-input.json")
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	var g group.Group
	if err := json.Unmarshal(run("group", "create", "--file", path), &g); err != nil {
		t.Fatal(err)
	}
	var bound struct{ Group string }
	if err := json.Unmarshal(run("group", "bind", "--group", string(g.ID), "--task", alone.ID), &bound); err != nil || bound.Group != string(g.ID) {
		t.Fatalf("bound=%+v %v", bound, err)
	}
	var made group.Group
	body, _ = json.Marshal(map[string]any{"kind": "local", "name": "For the other", "leader": "lead2", "members": []map[string]string{{"id": "lead2", "kind": "agent", "name": "Leader", "agentRole": "leader", "agent": "builtin-merakcode"}, {"id": "local-human", "kind": "human", "name": "Owner", "role": "owner"}}})
	if err := os.WriteFile(path, body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(run("group", "create", "--task", other.ID, "--file", path), &made); err != nil || made.Project.Directory != elsewhere {
		t.Fatalf("made=%+v %v", made.Project, err)
	}
	run("task", "cancel", "--task", alone.ID)
	run("task", "archive", "--tasks", alone.ID)
	if err := json.Unmarshal(run("task", "list", "--archived"), &listed); err != nil || len(listed) != 1 || listed[0].ID != alone.ID {
		t.Fatalf("archived=%+v %v", listed, err)
	}
	run("task", "archive", "--tasks", alone.ID, "--restore")
	if err := json.Unmarshal(run("task", "list", "--archived"), &listed); err != nil || len(listed) != 0 {
		t.Fatalf("after restoring: %+v %v", listed, err)
	}
}
