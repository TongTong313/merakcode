package migrate_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// v03Schema is the table layout of data/merakcode.db in v0.3, without the full-text index.
const v03Schema = `
CREATE TABLE record (key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE message (session_id TEXT NOT NULL, id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id));
CREATE TABLE part (session_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id));
CREATE TABLE review_baseline (session_id TEXT NOT NULL, path TEXT NOT NULL, data BLOB, PRIMARY KEY (session_id, path));
`

// fixture is a MerakCode root of v0.3: data/merakcode.db built with the v0.3 table layout.
type fixture struct {
	t    *testing.T
	root string
	db   *sql.DB
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(root, "data", "merakcode.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(v03Schema); err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, root: root, db: db}
	t.Cleanup(func() { db.Close() })
	return f
}

func (f *fixture) must(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(query, args...); err != nil {
		f.t.Fatal(err)
	}
}

func marshal(t *testing.T, value any) string {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

type obj = map[string]any

// session adds a conversation. extra is merged into the stored info.
func (f *fixture) session(id, parent, directory, title string, created, updated int64, extra obj) {
	f.t.Helper()
	info := obj{"id": id, "slug": "slug-" + id, "projectID": "proj", "directory": directory, "title": title, "version": "0.3.1", "time": obj{"created": created, "updated": updated}}
	if parent != "" {
		info["parentID"] = parent
	}
	for key, value := range extra {
		info[key] = value
	}
	var parentValue any
	if parent != "" {
		parentValue = parent
	}
	f.must("INSERT INTO session (id, project_id, parent_id, title, updated, data) VALUES (?, 'proj', ?, ?, ?, ?)", id, parentValue, title, updated, marshal(f.t, info))
}

func (f *fixture) user(session, id string, created int64, provider, modelID string, extra obj) {
	f.t.Helper()
	info := obj{"id": id, "sessionID": session, "role": "user", "time": obj{"created": created}, "agent": "build", "model": obj{"providerID": provider, "modelID": modelID}}
	for key, value := range extra {
		info[key] = value
	}
	f.must("INSERT INTO message (session_id, id, written, data) VALUES (?, ?, ?, ?)", session, id, created, marshal(f.t, info))
}

func (f *fixture) assistant(session, id string, created, completed int64, provider, modelID string, extra obj) {
	f.t.Helper()
	info := obj{"id": id, "sessionID": session, "role": "assistant", "time": obj{"created": created, "completed": completed}, "parentID": "", "modelID": modelID, "providerID": provider, "mode": "build", "agent": "build", "path": obj{"cwd": "/", "root": "/"}, "cost": 0, "tokens": obj{"input": 0, "output": 0, "reasoning": 0, "cache": obj{"read": 0, "write": 0}}}
	for key, value := range extra {
		info[key] = value
	}
	f.must("INSERT INTO message (session_id, id, written, data) VALUES (?, ?, ?, ?)", session, id, created, marshal(f.t, info))
}

func (f *fixture) part(session, message, id string, data obj) {
	f.t.Helper()
	data["id"], data["sessionID"], data["messageID"] = id, session, message
	f.rawPart(session, message, id, marshal(f.t, data))
}

func (f *fixture) rawPart(session, message, id, raw string) {
	f.t.Helper()
	f.must("INSERT INTO part (session_id, id, message_id, written, data) VALUES (?, ?, ?, 0, ?)", session, id, message, raw)
}

func (f *fixture) text(session, message, id, text string) {
	f.t.Helper()
	f.part(session, message, id, obj{"type": "text", "text": text})
}

func (f *fixture) record(key string, value any) {
	f.t.Helper()
	f.must("INSERT INTO record (key, data) VALUES (?, ?)", key, marshal(f.t, value))
}

// file writes a file below the root.
func (f *fixture) file(name, content string) {
	f.t.Helper()
	path := filepath.Join(f.root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

// snapshot returns the content of every file below the root, to compare before and after a run.
func (f *fixture) snapshot() map[string]string {
	f.t.Helper()
	result := map[string]string{}
	err := filepath.WalkDir(f.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(f.root, path)
		result[filepath.ToSlash(relative)] = string(body)
		return nil
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}
