-- Shared by the Go and TypeScript SQLite storage hosts.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  grp TEXT, task TEXT, session TEXT, turn TEXT,
  actor_kind TEXT NOT NULL, actor_id TEXT,
  cause TEXT,
  payload BLOB NOT NULL,
  UNIQUE (stream, seq)
);
CREATE INDEX IF NOT EXISTS events_group_time ON events (grp, time);
CREATE INDEX IF NOT EXISTS events_task_time ON events (task, time);
CREATE INDEX IF NOT EXISTS events_session_seq ON events (session, seq);
CREATE INDEX IF NOT EXISTS events_type_time ON events (type, time);
CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev > 0),
  body BLOB NOT NULL,
  meta TEXT,
  PRIMARY KEY (kind, key)
);
