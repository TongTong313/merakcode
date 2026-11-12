package protocol

import "github.com/TongTong313/merakcode/merak/engine/event"

// ImportProgress is published once for each conversation the migration from an earlier version has dealt with.
const ImportProgress event.Type = "import.progress"

func init() { event.Register[ImportProgressPayload](ImportProgress) }

// ImportProgressPayload says how far a migration has come: Done of Total conversations and groups.
type ImportProgressPayload struct {
	From  string `json:"from"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type ImportStartParams struct {
	// From names the earlier version; only "v0.3" is known.
	From string `json:"from"`
}

type ImportStartResult struct {
	// Started is false when a migration is already running.
	Started bool `json:"started"`
}

// ImportCounts is what a migration wrote, by kind.
type ImportCounts struct {
	Sessions int `json:"sessions"`
	Messages int `json:"messages"`
	Groups   int `json:"groups"`
	Agents   int `json:"agents"`
	Roles    int `json:"roles"`
	Plans    int `json:"plans"`
	Memories int `json:"memories"`
	Todos    int `json:"todos"`
	Blobs    int `json:"blobs"`
}

// ImportSkip is something the migration did not import. Code is the MRK code of the cause; Reason is a short
// diagnostic that never holds conversation content.
type ImportSkip struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Code   string `json:"code"`
	Reason string `json:"reason,omitempty"`
}

// ImportResult is the outcome of one run of the migration.
type ImportResult struct {
	From     string       `json:"from"`
	Imported ImportCounts `json:"imported"`
	Skipped  []ImportSkip `json:"skipped"`
	// Adapters names the hand-written adapters that cannot be imported.
	Adapters []string `json:"adapters,omitempty"`
}

// ImportStatus tells what the migration is doing now.
type ImportStatus struct {
	// Found says that data of the earlier version is on this machine.
	Found bool `json:"found"`
	// State is "idle" before a run, "running" during one and "done" after one.
	State  string        `json:"state"`
	Done   int           `json:"done"`
	Total  int           `json:"total"`
	Result *ImportResult `json:"result,omitempty"`
}
