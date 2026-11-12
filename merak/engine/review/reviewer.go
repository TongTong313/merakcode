package review

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/code"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

// The review keeps what the person has decided about the changes of one conversation. The changes are the
// difference between the workspace as the conversation found it and as it is now. Accepting a change makes it the
// new starting point of the review without touching any file; rejecting writes the starting point back into the
// working file. Neither touches the Git index or history.

// blob is the content of a file, or its absence.
type blob struct {
	Absent bool   `json:"absent,omitempty"`
	Data   []byte `json:"data,omitempty"`
}

func (b blob) equal(other blob) bool {
	return b.Absent == other.Absent && bytes.Equal(b.Data, other.Data)
}

type reviewUndo struct {
	File string `json:"file"`
	// Previous is the starting point the file had before the decision; nil when it had none of its own.
	Previous *blob `json:"previous,omitempty"`
	// Working and Written are the working file before a rejection and what the rejection wrote.
	Working *blob `json:"working,omitempty"`
	Written *blob `json:"written,omitempty"`
}

type reviewStep struct {
	Decision string       `json:"decision"`
	Files    []reviewUndo `json:"files"`
}

type reviewDoc struct {
	Baselines map[string]blob `json:"baselines,omitempty"`
	Steps     []reviewStep    `json:"steps,omitempty"`
}

const reviewSteps = 20

func readBlob(path string) (blob, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return blob{Absent: true}, nil
	}
	return blob{Data: data}, err
}

func writeBlob(path string, value blob) error {
	if value.Absent {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, value.Data, mode)
}

func (r *Reviewer) loadReview(ctx context.Context, id event.ID) (reviewDoc, uint64, error) {
	doc, err := r.deps.Store.Fetch(ctx, "review", string(id))
	if errors.Is(err, store.ErrNotFound) {
		return reviewDoc{}, 0, nil
	}
	if err != nil {
		return reviewDoc{}, 0, err
	}
	var value reviewDoc
	if err := json.Unmarshal(doc.Body, &value); err != nil {
		return reviewDoc{}, 0, err
	}
	return value, doc.Rev, nil
}

func (r *Reviewer) saveReview(ctx context.Context, id event.ID, value reviewDoc, rev uint64) error {
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return r.deps.Store.Put(ctx, store.Doc{Kind: "review", Key: string(id), Rev: rev, Body: body})
}

// Changes is the review of a conversation, or of one turn when a message is named: what changed, minus what was
// accepted.
func (r *Reviewer) Changes(ctx context.Context, id, message event.ID) ([]git.Change, error) {
	scope, err := r.reviewOf(ctx, id, message)
	return scope.changes, err
}

// reviewScope is the review of a conversation or of one of its turns.
type reviewScope struct {
	directory string
	changes   []git.Change
	doc       reviewDoc
	rev       uint64
	// before reads a changed file as the review started from it, binary files included.
	before func(context.Context, git.Change) (blob, error)
}

// reviewDirectory is the folder of a conversation with what was decided about its review.
func (r *Reviewer) reviewDirectory(ctx context.Context, id event.ID) (string, reviewDoc, uint64, error) {
	state, err := r.deps.Session(ctx, id)
	if err != nil {
		return "", reviewDoc{}, 0, err
	}
	doc, rev, err := r.loadReview(ctx, id)
	return r.deps.Directory(state.Config.Workdir), doc, rev, err
}

// reviewOf is the review of a conversation: what changed since it started, or in the turn of a message when one is
// named (LastTurn for the latest), minus what was accepted.
func (r *Reviewer) reviewOf(ctx context.Context, id, message event.ID) (reviewScope, error) {
	directory, doc, rev, err := r.reviewDirectory(ctx, id)
	if err != nil {
		return reviewScope{}, err
	}
	scope := reviewScope{directory: directory, doc: doc, rev: rev}
	var changes []git.Change
	if message != "" {
		if changes, scope.before, err = r.turnChanges(ctx, id, message); err != nil {
			return reviewScope{}, err
		}
	} else {
		state, err := r.deps.Session(ctx, id)
		if err != nil {
			return reviewScope{}, err
		}
		if changes, err = git.Diff(ctx, directory, state.BaseCommit); err != nil {
			return reviewScope{}, err
		}
		scope.before = func(ctx context.Context, change git.Change) (blob, error) {
			return baseBlob(ctx, directory, state.BaseCommit, change)
		}
		touched, tracked, err := r.agentTouched(ctx, id, state)
		if err != nil {
			return reviewScope{}, err
		}
		if tracked {
			changes = slices.DeleteFunc(changes, func(change git.Change) bool { return !touched[change.Path] })
		}
	}
	scope.changes, err = acceptedOut(directory, changes, doc.Baselines, message == "")
	return scope, err
}

// agentTouched lists the files the turns of a conversation changed, so what the person edits by hand beside the
// agent is not put in front of them as the agent's work. tracked is false for a conversation that takes no snapshots
// (an external product, or snapshots switched off): all its changes are listed then.
func (r *Reviewer) agentTouched(ctx context.Context, id event.ID, state session.State) (map[string]bool, bool, error) {
	// A conversation that has run no turn has no agent work to tell from the person's: it lists what differs
	if !r.deps.SnapshotsEnabled() || len(state.Marks) == 0 {
		return nil, false, nil
	}
	if external, err := r.deps.External(ctx, id); err != nil || external {
		return nil, false, err
	}
	repo, err := r.deps.Repo(id, state.Config.Workdir)
	if err != nil {
		return nil, false, err
	}
	touched := map[string]bool{}
	for i, mark := range state.Marks {
		from := state.RestoreTree(mark.Index)
		if from == "" {
			continue
		}
		next := -1
		if i+1 < len(state.Marks) {
			next = state.Marks[i+1].Index
		}
		to := state.EndTree(mark.Index, next)
		if to == "" {
			if to, err = repo.Track(ctx); err != nil {
				return nil, false, err
			}
		}
		listed, err := repo.Changes(ctx, from, to)
		if err != nil {
			return nil, false, err
		}
		for _, change := range listed {
			touched[change.Path] = true
		}
	}
	return touched, true, nil
}

// turnChanges is what one turn did to the files, read from the snapshots taken around it.
func (r *Reviewer) turnChanges(ctx context.Context, id, message event.ID) ([]git.Change, func(context.Context, git.Change) (blob, error), error) {
	state, err := r.deps.Session(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if message == LastTurn {
		if len(state.Marks) == 0 {
			return nil, nil, nil
		}
		message = state.Marks[len(state.Marks)-1].ID
	}
	mark, ok := state.MarkOf(message)
	if !ok {
		return nil, nil, ErrNoSuchTurn
	}
	from := state.RestoreTree(mark.Index)
	if from == "" || !r.deps.SnapshotsEnabled() {
		return nil, nil, nil
	}
	repo, err := r.deps.Repo(id, state.Config.Workdir)
	if err != nil {
		return nil, nil, err
	}
	next := -1
	for _, other := range state.Marks {
		if other.Index > mark.Index {
			next = other.Index
			break
		}
	}
	// The files the agent changed in the turn: what differs between its start and its end, or now while it runs
	to := state.EndTree(mark.Index, next)
	if to == "" {
		if to, err = repo.Track(ctx); err != nil {
			return nil, nil, err
		}
	}
	listed, err := repo.Changes(ctx, from, to)
	if err != nil {
		return nil, nil, err
	}
	changes := make([]git.Change, 0, len(listed))
	for _, entry := range listed {
		was, wasThere, err := repo.Blob(ctx, from, entry.Path)
		if err != nil {
			return nil, nil, err
		}
		// The latest turn is judged against the file as it is now, so a version names what a decision would act on;
		// an earlier turn against the file as that turn left it
		var now blob
		if next < 0 {
			absolute, _, err := code.Inside(state.Config.Workdir, entry.Path)
			if err != nil {
				return nil, nil, err
			}
			if now, err = readBlob(absolute); err != nil {
				return nil, nil, err
			}
		} else {
			data, there, err := repo.Blob(ctx, to, entry.Path)
			if err != nil {
				return nil, nil, err
			}
			now = blob{Absent: !there, Data: data}
		}
		if wasThere == !now.Absent && bytes.Equal(was, now.Data) {
			continue // back to where the turn started: nothing left to review
		}
		status := "modified"
		if !wasThere {
			status = "added"
		}
		if now.Absent {
			status = "deleted"
		}
		changes = append(changes, git.NewChange(git.File{Path: entry.Path, Status: status}, was, now.Data))
	}
	return changes, func(ctx context.Context, change git.Change) (blob, error) {
		data, present, err := repo.Blob(ctx, from, change.Path)
		return blob{Absent: !present, Data: data}, err
	}, nil
}

// acceptedOut replaces the starting point of every accepted file with the accepted one. A file that is back to
// its accepted contents is no longer a change. A review of the whole conversation also lists accepted files that
// changed again after the agent put them back to where the conversation began (addMissing).
func acceptedOut(directory string, changes []git.Change, baselines map[string]blob, addMissing bool) ([]git.Change, error) {
	if len(baselines) == 0 {
		return changes, nil
	}
	result := make([]git.Change, 0, len(changes))
	seen := map[string]bool{}
	rebuild := func(name string, baseline blob) error {
		seen[name] = true
		absolute, _, err := code.Inside(directory, name)
		if err != nil {
			return err
		}
		working, err := readBlob(absolute)
		if err != nil || working.equal(baseline) {
			return err
		}
		status := "modified"
		if baseline.Absent {
			status = "added"
		} else if working.Absent {
			status = "deleted"
		}
		result = append(result, git.NewChange(git.File{Path: name, Status: status}, baseline.Data, working.Data))
		return nil
	}
	for _, change := range changes {
		if baseline, accepted := baselines[change.Path]; accepted {
			if err := rebuild(change.Path, baseline); err != nil {
				return nil, err
			}
			continue
		}
		result = append(result, change)
	}
	for _, name := range slices.Sorted(maps.Keys(baselines)) {
		if addMissing && !seen[name] {
			if err := rebuild(name, baselines[name]); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

// ReviewStatus tells what the person can undo in a conversation's review.
func (r *Reviewer) Status(ctx context.Context, id event.ID) (Status, error) {
	_, doc, _, err := r.reviewDirectory(ctx, id)
	return statusOf(doc), err
}

func statusOf(doc reviewDoc) Status {
	if len(doc.Steps) == 0 {
		return Status{}
	}
	last := doc.Steps[len(doc.Steps)-1]
	return Status{Last: &Last{Decision: last.Decision, Count: len(last.Files)}}
}

// ReviewAccept makes the current contents of files the starting point of the review.
func (r *Reviewer) Accept(ctx context.Context, id, message event.ID, files []File) (Status, error) {
	return r.decide(ctx, id, message, "accept", files)
}

// ReviewReject puts the starting point of files back into the working files.
func (r *Reviewer) Reject(ctx context.Context, id, message event.ID, files []File) (Status, error) {
	return r.decide(ctx, id, message, "reject", files)
}

func (r *Reviewer) decide(ctx context.Context, id, message event.ID, decision string, files []File) (Status, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	scope, err := r.reviewOf(ctx, id, message)
	if err != nil {
		return Status{}, err
	}
	directory, doc, rev := scope.directory, scope.doc, scope.rev
	byPath := map[string]git.Change{}
	for _, change := range scope.changes {
		byPath[change.Path] = change
	}
	for _, file := range files {
		if change, ok := byPath[file.File]; !ok || change.Version != file.Version {
			return Status{}, ErrStale
		}
	}
	if doc.Baselines == nil {
		doc.Baselines = map[string]blob{}
	}
	step := reviewStep{Decision: decision}
	for _, file := range files {
		undo := reviewUndo{File: file.File}
		if previous, own := doc.Baselines[file.File]; own {
			undo.Previous = &previous
		}
		absolute, _, err := code.Inside(directory, file.File)
		if err != nil {
			return Status{}, err
		}
		working, err := readBlob(absolute)
		if err != nil {
			return Status{}, err
		}
		if decision == "accept" {
			next := working
			if file.Text != nil {
				next = blob{Data: []byte(*file.Text)}
			}
			doc.Baselines[file.File] = next
			step.Files = append(step.Files, undo)
			continue
		}
		var target blob
		switch own, accepted := doc.Baselines[file.File]; {
		case file.Text != nil:
			target = blob{Data: []byte(*file.Text)}
		case accepted:
			target = own
		default:
			if target, err = scope.before(ctx, byPath[file.File]); err != nil {
				return Status{}, err
			}
		}
		undo.Working, undo.Written = &working, &target
		if err := writeBlob(absolute, target); err != nil {
			return Status{}, err
		}
		step.Files = append(step.Files, undo)
	}
	doc.Steps = append(doc.Steps, step)
	if len(doc.Steps) > reviewSteps {
		doc.Steps = doc.Steps[len(doc.Steps)-reviewSteps:]
	}
	if err := r.saveReview(ctx, id, doc, rev); err != nil {
		return Status{}, err
	}
	r.deps.Announce(ctx, id, decision, len(files))
	return statusOf(doc), nil
}

// baseBlob is the contents a file had when the conversation started.
func baseBlob(ctx context.Context, directory, base string, change git.Change) (blob, error) {
	name := change.Path
	if change.OldPath != "" {
		name = change.OldPath
	}
	data, present, err := git.BytesAt(ctx, directory, base, name)
	if err != nil {
		return blob{}, err
	}
	return blob{Absent: !present, Data: data}, nil
}

// ReviewUndo takes back the latest accept or reject, as long as the files are still as that decision left them.
func (r *Reviewer) Undo(ctx context.Context, id event.ID) (Status, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	directory, doc, rev, err := r.reviewDirectory(ctx, id)
	if err != nil {
		return Status{}, err
	}
	if len(doc.Steps) == 0 {
		return Status{}, ErrNothingToUndo
	}
	step := doc.Steps[len(doc.Steps)-1]
	for _, undo := range step.Files {
		if undo.Written == nil {
			continue
		}
		absolute, _, err := code.Inside(directory, undo.File)
		if err != nil {
			return Status{}, err
		}
		if current, err := readBlob(absolute); err != nil || !current.equal(*undo.Written) {
			return Status{}, ErrNothingToUndo
		}
	}
	for _, undo := range slices.Backward(step.Files) {
		if undo.Previous != nil {
			doc.Baselines[undo.File] = *undo.Previous
		} else {
			delete(doc.Baselines, undo.File)
		}
		if undo.Working == nil {
			continue
		}
		absolute, _, _ := code.Inside(directory, undo.File)
		if err := writeBlob(absolute, *undo.Working); err != nil {
			return Status{}, err
		}
	}
	doc.Steps = doc.Steps[:len(doc.Steps)-1]
	if err := r.saveReview(ctx, id, doc, rev); err != nil {
		return Status{}, err
	}
	r.deps.Announce(ctx, id, "undo", len(step.Files))
	return statusOf(doc), nil
}
