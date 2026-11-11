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
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSessionCommandsListRenameArchiveExportImportAndDelete(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Hello from the model."})}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	facts, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{loop.TurnFinished}})
	defer stop()
	if err := e.Send(t.Context(), id, []model.Part{{Text: "Say hello"}}); err != nil {
		t.Fatal(err)
	}
	<-facts

	run := func(args ...string) (int, string) {
		var out bytes.Buffer
		code := Run(args, strings.NewReader(""), &out)
		return code, out.String()
	}
	listed := func(args ...string) []session.Info {
		t.Helper()
		code, out := run(args...)
		var infos []session.Info
		if code != 0 || json.Unmarshal([]byte(out), &infos) != nil {
			t.Fatalf("%v=%d %s", args, code, out)
		}
		return infos
	}
	if infos := listed("session", "list"); len(infos) != 1 || infos[0].ID != id {
		t.Fatalf("list=%+v", infos)
	}
	if code, out := run("session", "rename", "--session", string(id), "--title", "Greeting"); code != 0 {
		t.Fatalf("rename=%d %s", code, out)
	}
	if code, out := run("session", "show", "--session", string(id)); code != 0 || !strings.Contains(out, "Say hello") || !strings.Contains(out, "Greeting") {
		t.Fatalf("show=%d %s", code, out)
	}
	if code, out := run("session", "archive", "--session", string(id)); code != 0 {
		t.Fatalf("archive=%d %s", code, out)
	}
	if infos := listed("session", "list"); len(infos) != 0 {
		t.Fatalf("an archived session is listed: %+v", infos)
	}
	if infos := listed("session", "list", "--archived"); len(infos) != 1 || infos[0].Title != "Greeting" {
		t.Fatalf("archive=%+v", infos)
	}
	if code, out := run("session", "archive", "--session", string(id), "--restore"); code != 0 {
		t.Fatalf("restore=%d %s", code, out)
	}

	file := filepath.Join(home, "export.json")
	if code, out := run("export", "--session", string(id), "--file", file); code != 0 {
		t.Fatalf("export=%d %s", code, out)
	}
	if code, out := run("import", file); code != 0 {
		t.Fatalf("import=%d %s", code, out)
	} else {
		var result protocol.SessionCreateResult
		if json.Unmarshal([]byte(out), &result) != nil || result.Session == "" || result.Session == id {
			t.Fatalf("import printed %s", out)
		}
	}
	infos := listed("session", "list")
	if len(infos) != 2 {
		t.Fatalf("after the import: %+v", infos)
	}
	if code, out := run("export"); code != 0 || !json.Valid([]byte(out)) {
		t.Fatalf("export without a session picks the latest one: %d %s", code, out)
	}
	if code, out := run("session", "delete", "--session", string(id)); code != 0 {
		t.Fatalf("delete=%d %s", code, out)
	}
	if infos := listed("session", "list"); len(infos) != 1 || infos[0].ID == id {
		t.Fatalf("after the delete: %+v", infos)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal(err)
	}
	if code, _ := run("session", "rename", "--session", string(id)); code != 2 {
		t.Fatalf("rename without a title must be a usage error, got %d", code)
	}
}
