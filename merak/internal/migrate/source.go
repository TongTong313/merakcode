package migrate

import (
	"context"
	"database/sql"
	"net/url"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// source reads data/merakcode.db of v0.3. The database is opened read-only and nothing here writes to it.
type source struct{ db *sql.DB }

type row struct {
	ID   string
	Data string
}

type partRow struct {
	ID, Message, Data string
}

func databasePath(root string) string { return filepath.Join(root, "data", "merakcode.db") }

func openSource(path string) (*source, error) {
	// A Windows path such as C:\x needs the slash form inside a file: URL.
	slashed := filepath.ToSlash(path)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	address := url.URL{Scheme: "file", Path: slashed, RawQuery: url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(5000)"}}.Encode()}
	db, err := sql.Open("sqlite", address.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return &source{db: db}, nil
}

func (s *source) Close() error { return s.db.Close() }

// missingTable reports an error of a table that this database does not have; v0.3 databases of every version are
// read, and a table that came later is simply empty.
func missingTable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
}

func (s *source) rows(ctx context.Context, query string, args ...any) ([][]string, error) {
	found, err := s.db.QueryContext(ctx, query, args...)
	if missingTable(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer found.Close()
	columns, err := found.Columns()
	if err != nil {
		return nil, err
	}
	var result [][]string
	for found.Next() {
		values := make([]sql.NullString, len(columns))
		targets := make([]any, len(columns))
		for i := range values {
			targets[i] = &values[i]
		}
		if err := found.Scan(targets...); err != nil {
			return nil, err
		}
		line := make([]string, len(columns))
		for i, value := range values {
			line[i] = value.String
		}
		result = append(result, line)
	}
	return result, found.Err()
}

// sessions returns every conversation row, oldest identifier first.
func (s *source) sessions(ctx context.Context) ([]row, error) {
	lines, err := s.rows(ctx, "SELECT id, data FROM session ORDER BY id")
	if err != nil {
		return nil, err
	}
	result := make([]row, len(lines))
	for i, line := range lines {
		result[i] = row{ID: line[0], Data: line[1]}
	}
	return result, nil
}

func (s *source) messages(ctx context.Context, session string) ([]row, error) {
	lines, err := s.rows(ctx, "SELECT id, data FROM message WHERE session_id = ? ORDER BY id", session)
	if err != nil {
		return nil, err
	}
	result := make([]row, len(lines))
	for i, line := range lines {
		result[i] = row{ID: line[0], Data: line[1]}
	}
	return result, nil
}

func (s *source) parts(ctx context.Context, session string) ([]partRow, error) {
	lines, err := s.rows(ctx, "SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY id", session)
	if err != nil {
		return nil, err
	}
	result := make([]partRow, len(lines))
	for i, line := range lines {
		result[i] = partRow{ID: line[0], Message: line[1], Data: line[2]}
	}
	return result, nil
}

// records returns the small records whose key starts with a prefix such as "todo/".
func (s *source) records(ctx context.Context, prefix string) ([]row, error) {
	lines, err := s.rows(ctx, "SELECT key, data FROM record WHERE key >= ? AND key < ? ORDER BY key", prefix, prefix+"\xff")
	if err != nil {
		return nil, err
	}
	result := make([]row, len(lines))
	for i, line := range lines {
		result[i] = row{ID: strings.TrimPrefix(line[0], prefix), Data: line[1]}
	}
	return result, nil
}
