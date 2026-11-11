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
	body, _ := json.Marshal(map[string]any{"kind": "local", "name": "CLI group", "project": map[string]string{"directory": home}, "leader": "leader", "members": []map[string]string{{"id": "leader", "kind": "agent", "name": "Leader", "agentRole": "leader", "agent": "builtin-leader"}, {"id": "local-human", "kind": "human", "name": "Owner", "role": "owner"}}})
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
		{"group", "pause", "--group", string(g.ID)},
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
