// Package review holds the shapes a client and the engine exchange about the review of a conversation.
package review

import (
	"context"
	"errors"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/snapshot"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// File names one file of a decision, as the client last saw it.
type File struct {
	File string `json:"file"`
	// Version is the version of the change the client saw; a file that changed since makes the decision stale.
	Version string `json:"version"`
	// Text is the result of a decision on some hunks of the file: the new starting point when accepting, the new
	// working file when rejecting. Without it the decision is about the whole file.
	Text *string `json:"text,omitempty"`
}

// Last is the latest decision that can still be undone.
type Last struct {
	Decision string `json:"decision"`
	Count    int    `json:"count"`
}

// Status is what a client needs besides the changes: whether and what it can undo.
type Status struct {
	Last *Last `json:"last,omitempty"`
}

// LastTurn stands for the latest turn of a conversation where a message id is asked for.
const LastTurn = "last"

// Errors a decision can end with; the engine gives them their MRK codes.
var (
	// ErrStale says a file changed after the client listed it.
	ErrStale = errors.New("the file changed since it was listed")
	// ErrNothingToUndo says there is no decision to take back, or a file moved on after it.
	ErrNothingToUndo = errors.New("nothing to undo")
	// ErrNoSuchTurn says the message is not a visible message of the conversation.
	ErrNoSuchTurn = errors.New("not a visible message of this session")
)

// Deps is what the review needs from the engine.
type Deps struct {
	Store store.Store
	// Session reads a conversation, whether it is open or not.
	Session func(context.Context, event.ID) (session.State, error)
	// Directory gives a folder its canonical form.
	Directory func(string) string
	// Repo is the shadow repository of a conversation's workspace.
	Repo func(id event.ID, workdir string) (snapshot.Repo, error)
	// SnapshotsEnabled says whether workspaces are being recorded.
	SnapshotsEnabled func() bool
	// External says whether the conversation is run by an external product, which takes no snapshots.
	External func(context.Context, event.ID) (bool, error)
	// Announce tells the clients of a conversation that its review changed.
	Announce func(ctx context.Context, id event.ID, decision string, count int)
}

// Reviewer keeps the review of every conversation.
type Reviewer struct {
	deps Deps
	mu   sync.Mutex
}

// New makes a Reviewer.
func New(deps Deps) *Reviewer { return &Reviewer{deps: deps} }
