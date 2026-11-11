package localstore_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/localstore"
	_ "modernc.org/sqlite"
)

// legacyDatabase writes a database the way builds before the format number did: only the documents table matters here.
func legacyDatabase(t *testing.T, kind string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "merak.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, statement := range []string{
		"CREATE TABLE docs (kind TEXT NOT NULL, key TEXT NOT NULL, rev INTEGER NOT NULL CHECK (rev > 0), body BLOB NOT NULL, meta TEXT, PRIMARY KEY (kind, key))",
		"INSERT INTO docs (kind, key, rev, body) VALUES ('" + kind + "', 'k', 1, x'31')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// The data of earlier development builds kept agents as "profile" documents; it is not migrated, and the engine says
// so instead of misreading it.
func TestAnOldDatabaseWithProfileDocumentsIsRefusedWithAnUpgradeCode(t *testing.T) {
	_, err := localstore.Open(legacyDatabase(t, "profile"))
	if err == nil || err.Error() != "MRK-1008" {
		t.Fatalf("Open = %v, want MRK-1008", err)
	}
}

func TestAnOldDatabaseWithoutProfileDocumentsIsUpgradedInPlaceAndKeepsItsData(t *testing.T) {
	path := legacyDatabase(t, "note")
	for range 2 {
		s, err := localstore.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		doc, err := s.Fetch(context.Background(), "note", "k")
		if err != nil || string(doc.Body) != "1" {
			t.Fatalf("doc=%+v err=%v", doc, err)
		}
		s.Close()
	}
}
