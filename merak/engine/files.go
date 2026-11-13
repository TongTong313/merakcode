package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/code"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/folderwatch"
	"github.com/TongTong313/merakcode/merak/engine/review"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/internal/platform/watch"
)

type FileContent struct {
	Type    string `json:"type"`
	Content string `json:"content"`
	MIME    string `json:"mime,omitempty"`
	// Checksum names the exact bytes that were read; saving against it detects an outside change.
	Checksum string `json:"checksum,omitempty"`
	// Head is the text the last commit holds for this file; absent when the file is not tracked.
	Head *string `json:"head,omitempty"`
	// Missing marks a tracked file that was deleted from disk; Content is then its last committed text.
	Missing bool `json:"missing,omitempty"`
}

type FileNode struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	// Ignored marks an entry Git ignores, so a tree can hide it.
	Ignored bool `json:"ignored,omitempty"`
}

func (e *Engine) directory(directory string) string {
	if directory == "" {
		return canonicalDirectory(e.workdir)
	}
	return canonicalDirectory(directory)
}

func (e *Engine) ListFiles(ctx context.Context, directory, path string) ([]FileNode, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	directory = e.directory(directory)
	if missing(directory) {
		return nil, coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
	}
	absolute := path
	if !filepath.IsAbs(path) {
		absolute = filepath.Join(directory, path)
	}
	entries, err := os.ReadDir(absolute)
	if err != nil {
		return nil, err
	}
	result := []FileNode{}
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		node := FileNode{Name: entry.Name(), Path: filepath.ToSlash(filepath.Join(path, entry.Name())), Type: "file"}
		if entry.IsDir() {
			node.Type = "directory"
		}
		result = append(result, node)
	}
	paths := make([]string, len(result))
	for i, node := range result {
		paths[i] = node.Path
	}
	if ignored := git.IgnoredAmong(ctx, directory, paths); len(ignored) > 0 {
		for i := range result {
			result[i].Ignored = ignored[result[i].Path]
		}
	}
	return result, nil
}

func (e *Engine) RepoStatus(ctx context.Context, directory string) (git.State, error) {
	return git.Status(ctx, e.directory(directory))
}

func (e *Engine) RepoBranches(ctx context.Context, directory string) ([]git.Branch, error) {
	return git.Branches(ctx, e.directory(directory))
}

func (e *Engine) RepoCheckout(ctx context.Context, directory, branch string) error {
	return git.Checkout(ctx, e.directory(directory), branch)
}

func (e *Engine) RepoDiff(ctx context.Context, directory, base string, sessionID, message event.ID) ([]git.Change, error) {
	if sessionID != "" {
		if base != "" {
			return nil, errors.New("choose a session or a commit")
		}
		changes, err := e.reviewer().Changes(ctx, sessionID, message)
		return changes, reviewError(err)
	}
	return git.Diff(ctx, e.directory(directory), base)
}

// canonicalDirectory gives the folder of a request its one form, so every spelling of it reaches the same
// workspace. A folder that does not exist keeps its cleaned spelling and is reported by the call that needs it.
func canonicalDirectory(directory string) string {
	if directory == "" {
		return ""
	}
	if canonical, err := workspace.Canonical(directory); err == nil {
		return canonical
	}
	return directory
}

// RepoCommit records working changes in one commit: the chosen files, or everything when none are chosen.
func (e *Engine) RepoCommit(ctx context.Context, directory, message string, paths []string) (string, error) {
	return git.CommitChanges(ctx, e.directory(directory), message, paths)
}

// RepoStage adds files to the index.
func (e *Engine) RepoStage(ctx context.Context, directory string, paths []string) error {
	return git.Stage(ctx, e.directory(directory), paths)
}

// RepoUnstage takes files out of the index and leaves the working files alone.
func (e *Engine) RepoUnstage(ctx context.Context, directory string, paths []string) error {
	return git.Unstage(ctx, e.directory(directory), paths)
}

// RepoCommitStaged records what the index holds.
func (e *Engine) RepoCommitStaged(ctx context.Context, directory, message string) (string, error) {
	return git.CommitStaged(ctx, e.directory(directory), message)
}

// RepoPush sends the current branch to its remote.
func (e *Engine) RepoPush(ctx context.Context, directory string) error {
	return git.Push(ctx, e.directory(directory))
}

// RepoCommitMessage writes a commit message for the staged changes, or for all changes when nothing is staged,
// with the default model. It only returns text; nothing is committed.
func (e *Engine) RepoCommitMessage(ctx context.Context, directory string) (string, error) {
	diff, err := git.StagedDiff(ctx, e.directory(directory))
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(diff) == "" {
		return "", coded(errorcode.NothingToSummarize, errors.New("there are no changes"))
	}
	ref, ok := e.jobModel("summary")
	if !ok {
		return "", coded(errorcode.ModelRequestFailed, errors.New("no model is configured to write the message"))
	}
	if runes := []rune(diff); len(runes) > 60000 {
		diff = string(runes[:60000])
	}
	text, err := e.completeText(ctx, ref, "Write a Git commit message for the changes below: one subject line of at most 72 characters in the imperative mood, with no quotes and no trailing period. Reply with the subject only.", diff, 120)
	if err != nil {
		return "", err
	}
	if subject := cleanTitleTo(text, 72); subject != "" {
		return subject, nil
	}
	return "", coded(errorcode.ModelRequestFailed, errors.New("the model returned no message"))
}

// CreateWorktree makes the worktree of a key for a conversation, or returns the one that key already has.
func (e *Engine) CreateWorktree(ctx context.Context, directory, key, branch string) (code.Worktree, error) {
	return e.CreateWorktreeFrom(ctx, directory, key, branch, "")
}

// CreateWorktreeFrom makes the worktree of a key starting from the given branch, which stays checked out where it is.
func (e *Engine) CreateWorktreeFrom(ctx context.Context, directory, key, branch, base string) (code.Worktree, error) {
	return e.worktrees().CreateFrom(ctx, e.directory(directory), key, branch, base)
}

// ListWorktrees lists the worktrees this engine made for the repository of a directory.
func (e *Engine) ListWorktrees(ctx context.Context, directory string) ([]code.Worktree, error) {
	return e.worktrees().List(ctx, e.directory(directory))
}

// MergeWorktree merges the branch of a conversation worktree into the main folder's branch.
func (e *Engine) MergeWorktree(ctx context.Context, path string) error {
	conflicts, err := e.worktrees().Merge(ctx, path)
	if err == nil {
		return nil
	}
	if len(conflicts) > 0 {
		return coded(errorcode.WorktreeMergeConflict, fmt.Errorf("conflicts in %s", strings.Join(conflicts, ", ")))
	}
	if strings.Contains(err.Error(), "not a worktree") {
		return coded(errorcode.WorktreeUnknown, err)
	}
	return err
}

// RemoveWorktree deletes a conversation worktree; its branch stays.
func (e *Engine) RemoveWorktree(ctx context.Context, path string) error {
	err := e.worktrees().Remove(ctx, path)
	if err != nil && strings.Contains(err.Error(), "not a worktree") {
		return coded(errorcode.WorktreeUnknown, err)
	}
	return err
}

func (e *Engine) worktrees() *code.Worktrees {
	e.worktreeOnce.Do(func() {
		home := e.dataDir
		if home == "" {
			home = filepath.Join(os.TempDir(), "merak-chat")
		}
		e.worktreeSet = &code.Worktrees{Store: e.store, Home: home}
	})
	return e.worktreeSet
}

// FileStatus is the Git state of one file.
func (e *Engine) FileStatus(ctx context.Context, directory, path string) (code.Status, error) {
	return code.FileStatus(ctx, e.directory(directory), path)
}

// FileIdentity names the canonical folder and the repository root of a path.
func (e *Engine) FileIdentity(ctx context.Context, directory, path string) (code.Identity, error) {
	directory = e.directory(directory)
	if missing(directory) {
		return code.Identity{}, coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
	}
	identity, err := code.FileIdentity(ctx, directory, path)
	if err != nil || identity.Root == "" {
		return identity, err
	}
	trees, err := e.worktrees().All(ctx)
	if err != nil {
		return identity, err
	}
	for _, tree := range trees {
		if workspace.SameDirectory(tree.Path, identity.Root) {
			identity.Worktree = tree.Key
		}
	}
	return identity, nil
}

// FindFiles finds project files by a part of their path.
func (e *Engine) FindFiles(ctx context.Context, directory, query string, limit int) ([]string, error) {
	return code.FindFiles(ctx, e.directory(directory), query, limit)
}

// Directory returns the canonical folder of a request; an empty one is the engine's own folder.
func (e *Engine) Directory(directory string) string { return e.directory(directory) }

// ReadFile returns a file as the editor shows it; see code.ReadFile.
func (e *Engine) ReadFile(ctx context.Context, directory, path string) (FileContent, error) {
	read, err := code.ReadFile(ctx, e.directory(directory), path)
	if err != nil {
		return FileContent{}, err
	}
	return FileContent{Type: read.Type, Content: read.Content, MIME: read.MIME, Checksum: read.Checksum, Head: read.Head, Missing: read.Missing}, nil
}

// WriteFile saves the text of the editor over the version it read; see code.WriteFile.
func (e *Engine) WriteFile(ctx context.Context, directory, path, content, expected string, force bool) (string, error) {
	checksum, err := code.WriteFile(ctx, e.directory(directory), path, content, expected, force)
	if errors.Is(err, code.ErrChanged) {
		return "", coded(errorcode.FileChanged, err)
	}
	return checksum, err
}

// missing says the folder of a request is gone; an empty one means the engine's own folder.
func missing(directory string) bool {
	if directory == "" {
		return false
	}
	_, err := os.Stat(directory)
	return errors.Is(err, fs.ErrNotExist)
}

// reviewer is the review of the engine's conversations, made on first use.
func (e *Engine) reviewer() *review.Reviewer {
	e.reviewOnce.Do(func() {
		e.reviews = review.New(review.Deps{
			Store:            e.store,
			Session:          e.SessionSnapshot,
			Directory:        e.directory,
			Repo:             e.snapshotRepo,
			SnapshotsEnabled: e.snapshotsEnabled,
			External: func(ctx context.Context, id event.ID) (bool, error) {
				e.mu.Lock()
				defer e.mu.Unlock()
				chat, err := e.externalChatOf(ctx, id)
				return chat != nil, err
			},
			Announce: func(ctx context.Context, id event.ID, decision string, count int) {
				e.mu.Lock()
				defer e.mu.Unlock()
				if c, err := e.openSession(ctx, id); err == nil {
					_, _ = e.publishSession(ctx, c, session.ReviewUpdated, session.ReviewUpdate{Decision: decision, Count: count})
				}
			},
		})
	})
	return e.reviews
}

// reviewError gives the errors of a review their codes.
func reviewError(err error) error {
	switch {
	case errors.Is(err, review.ErrStale):
		return coded(errorcode.ReviewStale, err)
	case errors.Is(err, review.ErrNothingToUndo):
		return coded(errorcode.NothingToUndo, err)
	case errors.Is(err, review.ErrNoSuchTurn):
		return coded(errorcode.RevertTargetInvalid, err)
	}
	return err
}

// ReviewAccept makes the current contents of files the starting point of the review of a conversation or one turn.
func (e *Engine) ReviewAccept(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	status, err := e.reviewer().Accept(ctx, id, message, files)
	return status, reviewError(err)
}

// ReviewReject puts the starting point of the review back into the working files.
func (e *Engine) ReviewReject(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	status, err := e.reviewer().Reject(ctx, id, message, files)
	return status, reviewError(err)
}

// ReviewUndo takes back the latest accept or reject of a conversation.
func (e *Engine) ReviewUndo(ctx context.Context, id event.ID) (review.Status, error) {
	status, err := e.reviewer().Undo(ctx, id)
	return status, reviewError(err)
}

// ReviewStatus tells what the person can undo in a conversation's review.
func (e *Engine) ReviewStatus(ctx context.Context, id event.ID) (review.Status, error) {
	status, err := e.reviewer().Status(ctx, id)
	return status, reviewError(err)
}

// SetDirectoryWatchInterval changes how often a watched folder is looked at; tests make it short.
func (e *Engine) SetDirectoryWatchInterval(interval time.Duration) {
	e.directoryWatches.SetInterval(interval)
}

// WatchDirectory makes the engine announce what changes in a folder without the engine having done it: a checkout or
// a commit as repo.changed and the files that changed as file.changed. It lasts until the owner lets go with
// UnwatchDirectories, which the server does when the connection of the owner closes. A group watches its own project
// folder through watchGroup; this is for the folders of conversations that no group watches.
func (e *Engine) WatchDirectory(ctx context.Context, owner, directory string) error {
	directory = e.directory(directory)
	if missing(directory) {
		return coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
	}
	return e.directoryWatches.Watch(ctx, folderwatch.Hooks{
		Context: e.ctx,
		Go:      func(run func()) { e.workers.Go(run) },
		Excluded: func(ctx context.Context) []string {
			excluded, _ := e.watchedWorkspaces(ctx)
			return excluded
		},
		Repository: func(ctx context.Context, directory string, changed watch.RepoChanged) {
			e.announceDirectory(ctx, directory, RepoChanged, RepoChanges{RepoChanged: changed})
		},
		Files: func(ctx context.Context, directory string, paths []string) {
			e.announceDirectory(ctx, directory, FileChanged, FileChanges{Directory: directory, Paths: paths})
		},
	}, owner, directory)
}

// UnwatchDirectories lets go of every folder the owner watches.
func (e *Engine) UnwatchDirectories(owner string) { e.directoryWatches.Unwatch(owner) }

// announceDirectory publishes a change of a folder on the stream of that folder; it belongs to no session or group.
func (e *Engine) announceDirectory(ctx context.Context, directory string, kind event.Type, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = e.Bus.Publish(ctx, event.Event{Stream: event.Stream("watch:" + directory), Actor: event.Actor{Kind: event.ActorSystem, ID: "watch"}, Type: kind, Payload: body})
}
