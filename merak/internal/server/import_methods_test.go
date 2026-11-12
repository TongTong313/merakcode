package server_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
	_ "modernc.org/sqlite"
)

// writeV03Database makes data/merakcode.db of v0.3 under a root with one conversation of one message.
func writeV03Database(t *testing.T, root, directory string) {
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
	statements := []string{
		`CREATE TABLE record (key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
		`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL)`,
		`CREATE TABLE message (session_id TEXT NOT NULL, id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id))`,
		`CREATE TABLE part (session_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, written INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session_id, id))`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	info := `{"id":"ses_1","slug":"s","projectID":"p","directory":` + quote(directory) + `,"title":"Imported chat","time":{"created":1700000000000,"updated":1700000001000}}`
	message := `{"id":"msg_1","sessionID":"ses_1","role":"user","time":{"created":1700000000000},"agent":"build","model":{"providerID":"fake","modelID":"m"}}`
	part := `{"id":"prt_1","sessionID":"ses_1","messageID":"msg_1","type":"text","text":"hello"}`
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

func quote(text string) string {
	body := []byte{'"'}
	for _, r := range text {
		if r == '\\' || r == '"' {
			body = append(body, '\\')
		}
		body = append(body, string(r)...)
	}
	return string(append(body, '"'))
}

func waitForImport(t *testing.T, ctx context.Context, client *protocol.Client) protocol.ImportStatus {
	t.Helper()
	for {
		var status protocol.ImportStatus
		if err := client.Call(ctx, "import.status", struct{}{}, &status); err != nil {
			t.Fatal(err)
		}
		if status.State == "done" {
			return status
		}
		select {
		case <-ctx.Done():
			t.Fatalf("the import did not finish: %+v", status)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestADaemonThatFindsV03DataImportsItInTheBackgroundAndTheMethodsShowAndRepeatIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	home := t.TempDir()
	writeV03Database(t, home, t.TempDir())
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	status := waitForImport(t, ctx, client)
	if !status.Found || status.Result == nil || status.Result.Imported.Sessions != 1 || status.Total != 1 || status.Done != 1 {
		t.Fatalf("status = %+v", status)
	}
	infos, err := e.ListSessions(ctx)
	if err != nil || len(infos) != 1 || infos[0].Title != "Imported chat" {
		t.Fatalf("sessions = %+v (%v)", infos, err)
	}
	notices, err := e.FindEvents(ctx, store.Query{Types: []event.Type{group.NoticeSent}})
	if err != nil || len(notices) != 1 || notices[0].Stream != event.Stream("inbox:"+client.Hello.Human) {
		t.Fatalf("notices = %+v (%v), want one in the inbox of the connection's person", notices, err)
	}
	var started protocol.ImportStartResult
	if err := client.Call(ctx, "import.start", protocol.ImportStartParams{From: "v0.3"}, &started); err != nil || !started.Started {
		t.Fatalf("start = %+v (%v)", started, err)
	}
	if again := waitForImport(t, ctx, client); again.Result.Imported.Sessions != 0 {
		t.Fatalf("the repeated run imported %+v", again.Result.Imported)
	}
	if infos, _ = e.ListSessions(ctx); len(infos) != 1 {
		t.Fatalf("%d sessions after the repeated run", len(infos))
	}
}

func TestStartingAnImportWithoutV03DataOrFromAnUnknownVersionIsRefusedWithACode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var status protocol.ImportStatus
	if err := client.Call(ctx, "import.status", struct{}{}, &status); err != nil || status.Found || status.State != "idle" {
		t.Fatalf("status = %+v (%v)", status, err)
	}
	for _, test := range []struct {
		name, from, code string
	}{
		{"no database", "v0.3", "MRK-3007"},
		{"unknown version", "v0.2", "MRK-3001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := client.Call(ctx, "import.start", protocol.ImportStartParams{From: test.from}, nil)
			if failure, ok := err.(*protocol.Error); !ok || failure.Data.Code != test.code {
				t.Fatalf("error = %v, want %s", err, test.code)
			}
		})
	}
}
