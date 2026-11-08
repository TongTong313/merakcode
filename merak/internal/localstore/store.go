// Package localstore implements the shared SQLite storage format for local clients.
package localstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	query := url.Values{"_pragma": {"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(FULL)"}, "_txlock": {"immediate"}}
	db, err := sql.Open("sqlite", path+"?"+query.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Append(ctx context.Context, events []event.Event) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, e := range events {
		var last uint64
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(seq), 0) FROM events WHERE stream = ?", e.Stream).Scan(&last); err != nil {
			return err
		}
		if e.ID == "" || e.Stream == "" || e.Seq != last+1 {
			return store.ErrSequence
		}
		var existing int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM events WHERE id = ?", e.ID).Scan(&existing); err != nil {
			return err
		}
		if existing != 0 {
			return store.ErrSequence
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO events (id, stream, seq, time, type, grp, task, session, turn, actor_kind, actor_id, cause, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", e.ID, e.Stream, e.Seq, timestamp(e.Time), e.Type, nullable(string(e.Scope.Group)), nullable(string(e.Scope.Task)), nullable(string(e.Scope.Session)), nullable(string(e.Scope.Turn)), e.Actor.Kind, nullable(string(e.Actor.ID)), nullable(string(e.Cause)), []byte(e.Payload))
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

const eventColumns = "id, stream, seq, time, type, COALESCE(grp,''), COALESCE(task,''), COALESCE(session,''), COALESCE(turn,''), actor_kind, COALESCE(actor_id,''), COALESCE(cause,''), payload"

func (s *Store) Read(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	return s.query(ctx, "SELECT "+eventColumns+" FROM events WHERE stream = ? AND seq >= ? ORDER BY seq LIMIT ?", stream, from, bound(limit))
}

func (s *Store) Find(ctx context.Context, q store.Query) ([]event.Event, error) {
	where := []string{"1 = 1"}
	args := []any{}
	for _, field := range []struct {
		name  string
		value event.ID
	}{{"grp", q.Scope.Group}, {"task", q.Scope.Task}, {"session", q.Scope.Session}, {"turn", q.Scope.Turn}} {
		if field.value != "" {
			where = append(where, field.name+" = ?")
			args = append(args, field.value)
		}
	}
	if len(q.Types) > 0 {
		where = append(where, "type IN ("+strings.TrimSuffix(strings.Repeat("?,", len(q.Types)), ",")+")")
		for _, kind := range q.Types {
			args = append(args, kind)
		}
	}
	if !q.After.IsZero() {
		where = append(where, "time > ?")
		args = append(args, timestamp(q.After))
	}
	if !q.Before.IsZero() {
		where = append(where, "time < ?")
		args = append(args, timestamp(q.Before))
	}
	args = append(args, bound(q.Limit))
	return s.query(ctx, "SELECT "+eventColumns+" FROM events WHERE "+strings.Join(where, " AND ")+" ORDER BY time, stream, seq LIMIT ?", args...)
}

func (s *Store) Get(ctx context.Context, id event.ID) (event.Event, error) {
	result, err := s.query(ctx, "SELECT "+eventColumns+" FROM events WHERE id = ?", id)
	if err != nil {
		return event.Event{}, err
	}
	if len(result) == 0 {
		return event.Event{}, store.ErrNotFound
	}
	return result[0], nil
}

func (s *Store) query(ctx context.Context, query string, args ...any) ([]event.Event, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []event.Event{}
	for rows.Next() {
		var e event.Event
		var stamp string
		var payload []byte
		if err := rows.Scan(&e.ID, &e.Stream, &e.Seq, &stamp, &e.Type, &e.Scope.Group, &e.Scope.Task, &e.Scope.Session, &e.Scope.Turn, &e.Actor.Kind, &e.Actor.ID, &e.Cause, &payload); err != nil {
			return nil, err
		}
		e.Payload = payload
		e.Time, err = time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}

func (s *Store) Put(ctx context.Context, doc store.Doc) error {
	meta, err := json.Marshal(doc.Meta)
	if err != nil {
		return err
	}
	body := doc.Body
	if body == nil {
		body = []byte{}
	}
	var result sql.Result
	if doc.Rev == 0 {
		result, err = s.db.ExecContext(ctx, "INSERT INTO docs (kind,key,rev,body,meta) VALUES (?,?,1,?,?) ON CONFLICT(kind,key) DO NOTHING", doc.Kind, doc.Key, body, string(meta))
	} else {
		result, err = s.db.ExecContext(ctx, "UPDATE docs SET rev = rev + 1, body = ?, meta = ? WHERE kind = ? AND key = ? AND rev = ?", body, string(meta), doc.Kind, doc.Key, doc.Rev)
	}
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return store.ErrConflict
	}
	return nil
}

func (s *Store) Fetch(ctx context.Context, kind, key string) (store.Doc, error) {
	doc := store.Doc{Kind: kind, Key: key}
	var meta string
	err := s.db.QueryRowContext(ctx, "SELECT rev,body,COALESCE(meta,'null') FROM docs WHERE kind = ? AND key = ?", kind, key).Scan(&doc.Rev, &doc.Body, &meta)
	if errors.Is(err, sql.ErrNoRows) {
		return store.Doc{}, store.ErrNotFound
	}
	if err != nil {
		return store.Doc{}, err
	}
	return doc, json.Unmarshal([]byte(meta), &doc.Meta)
}

func (s *Store) List(ctx context.Context, kind, prefix string) ([]store.DocMeta, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT key,rev,COALESCE(meta,'null') FROM docs WHERE kind = ? AND substr(key,1,length(?)) = ? ORDER BY key", kind, prefix, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []store.DocMeta{}
	for rows.Next() {
		doc := store.DocMeta{Kind: kind}
		var meta string
		if err := rows.Scan(&doc.Key, &doc.Rev, &meta); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(meta), &doc.Meta); err != nil {
			return nil, err
		}
		result = append(result, doc)
	}
	return result, rows.Err()
}

func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func bound(limit int) int {
	if limit <= 0 {
		return -1
	}
	return limit
}
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
