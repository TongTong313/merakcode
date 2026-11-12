package cli

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	_ "modernc.org/sqlite"
)

// writeLegacyDatabase makes data/merakcode.db of v0.3 under a root with one conversation of one message.
func writeLegacyDatabase(t *testing.T, root, directory string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "data", "merakcode.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	for _, statement := range []string{
		`CREATE TABLE record (key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
		`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL)`,
		`CREATE TABLE message (session_id TEXT NOT NULL, id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id))`,
		`CREATE TABLE part (session_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id))`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	body := func(value any) string {
		out, _ := json.Marshal(value)
		return string(out)
	}
	info := body(map[string]any{"id": "ses_1", "slug": "s", "projectID": "p", "directory": directory, "title": "Imported chat", "time": map[string]any{"created": 1700000000000, "updated": 1700000001000}})
	message := body(map[string]any{"id": "msg_1", "sessionID": "ses_1", "role": "user", "time": map[string]any{"created": 1700000000000}, "agent": "build", "model": map[string]any{"providerID": "fake", "modelID": "m"}})
	part := body(map[string]any{"id": "prt_1", "sessionID": "ses_1", "messageID": "msg_1", "type": "text", "text": "hello"})
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO session VALUES ('ses_1', 'p', NULL, 'Imported chat', 1700000001000, ?)", []any{info}},
		{"INSERT INTO message VALUES ('ses_1', 'msg_1', 0, ?)", []any{message}},
		{"INSERT INTO part VALUES ('ses_1', 'prt_1', 'msg_1', 0, ?)", []any{part}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImportFromV03RunsTheMigrationOnTheEngineAndReportsInTheLanguageOfTheUser(t *testing.T) {
	for _, test := range []struct {
		name, language string
		want           []string
	}{
		{"English", "en", []string{"1/1", "Imported 1 conversations", "skipped 0"}},
		{"Chinese", "zh", []string{"1/1", "已导入 1 个对话", "跳过 0"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("MERAKCODE_HOME", home)
			project := t.TempDir()
			writeLegacyDatabase(t, home, project)
			e, err := engine.New(engine.Deps{Workdir: project})
			if err != nil {
				t.Fatal(err)
			}
			instance, err := startAt(e, home)
			if err != nil {
				t.Fatal(err)
			}
			defer instance.Close()
			var out bytes.Buffer
			if code := Run([]string{"--lang", test.language, "import", "--from", "v0.3"}, strings.NewReader(""), &out); code != 0 {
				t.Fatalf("exit %d: %s", code, out.String())
			}
			for _, want := range test.want {
				if !strings.Contains(out.String(), want) {
					t.Fatalf("output lacks %q:\n%s", want, out.String())
				}
			}
			infos, err := e.ListSessions(t.Context())
			if err != nil || len(infos) != 1 || infos[0].Title != "Imported chat" {
				t.Fatalf("sessions = %+v (%v)", infos, err)
			}
		})
	}
}

func TestImportFromAnUnknownVersionOrWithoutDataFailsWithItsCode(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	for _, test := range []struct {
		name string
		args []string
		exit int
		code string
	}{
		{"no data", []string{"--lang", "en", "import", "--from", "v0.3"}, 1, "MRK-3007"},
		{"unknown version", []string{"--lang", "en", "import", "--from", "v0.2"}, 2, "MRK-3001"},
		{"a file and a version", []string{"--lang", "en", "import", "--from", "v0.3", "some.json"}, 2, "MRK-3001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			if code := Run(test.args, strings.NewReader(""), &out); code != test.exit || !strings.Contains(out.String(), test.code) {
				t.Fatalf("exit %d, want %d with %s:\n%s", code, test.exit, test.code, out.String())
			}
		})
	}
}
