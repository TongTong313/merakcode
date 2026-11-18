// Package project owns project files, reviews, worktrees and terminal access.
package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/collab/coordinator"
	"github.com/TongTong313/merakcode/merak/engine/feature/code"
	"github.com/TongTong313/merakcode/merak/engine/feature/folderwatch"
	"github.com/TongTong313/merakcode/merak/engine/feature/review"
	"github.com/TongTong313/merakcode/merak/engine/feature/terminal"
	"github.com/TongTong313/merakcode/merak/engine/infra/core"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
	"github.com/TongTong313/merakcode/merak/engine/infra/watch"
)

// Deps supplies the existing shared objects used by project operations.
type Deps struct {
	Core        *core.Core
	Registry    *registry.Registry
	Coordinator *coordinator.Coordinator
	Terminals   *terminal.Manager
	Review      review.Deps
	Worktrees   string
}

// New initializes the existing Project object before any background tasks start.
func New(target *Project, d Deps) *Project {
	target.core = d.Core
	target.registry = d.Registry
	target.coordinator = d.Coordinator
	target.terminals = d.Terminals
	target.reviewDeps = d.Review
	target.worktreeHome = d.Worktrees
	return target
}

// Project owns file review, conversation worktrees and directory watches.
type Project struct {
	core             *core.Core
	registry         *registry.Registry
	coordinator      *coordinator.Coordinator
	terminals        *terminal.Manager
	reviewDeps       review.Deps
	worktreeHome     string
	worktreeSet      *code.Worktrees
	worktreeOnce     sync.Once
	reviews          *review.Reviewer
	reviewOnce       sync.Once
	directoryWatches folderwatch.Watches
}

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

func (e *Project) ListFiles(ctx context.Context, directory, path string) ([]FileNode, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	directory = e.registry.Directory(directory)
	if registry.Missing(directory) {
		return nil, errorcode.Coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
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

func (e *Project) RepoStatus(ctx context.Context, directory string) (git.State, error) {
	return git.Status(ctx, e.registry.Directory(directory))
}

func (e *Project) RepoBranches(ctx context.Context, directory string) ([]git.Branch, error) {
	return git.Branches(ctx, e.registry.Directory(directory))
}

func (e *Project) RepoCheckout(ctx context.Context, directory, branch string) error {
	return git.Checkout(ctx, e.registry.Directory(directory), branch)
}

func (e *Project) RepoDiff(ctx context.Context, directory, base string, sessionID, message event.ID) ([]git.Change, error) {
	if sessionID != "" {
		if base != "" {
			return nil, errors.New("choose a session or a commit")
		}
		changes, err := e.reviewer().Changes(ctx, sessionID, message)
		return changes, reviewError(err)
	}
	return git.Diff(ctx, e.registry.Directory(directory), base)
}

// RepoCommit records working changes in one commit: the chosen files, or everything when none are chosen.
func (e *Project) RepoCommit(ctx context.Context, directory, message string, paths []string) (string, error) {
	return git.CommitChanges(ctx, e.registry.Directory(directory), message, paths)
}

// RepoStage adds files to the index.
func (e *Project) RepoStage(ctx context.Context, directory string, paths []string) error {
	return git.Stage(ctx, e.registry.Directory(directory), paths)
}

// RepoUnstage takes files out of the index and leaves the working files alone.
func (e *Project) RepoUnstage(ctx context.Context, directory string, paths []string) error {
	return git.Unstage(ctx, e.registry.Directory(directory), paths)
}

// RepoCommitStaged records what the index holds.
func (e *Project) RepoCommitStaged(ctx context.Context, directory, message string) (string, error) {
	return git.CommitStaged(ctx, e.registry.Directory(directory), message)
}

// RepoPush sends the current branch to its remote.
func (e *Project) RepoPush(ctx context.Context, directory string) error {
	return git.Push(ctx, e.registry.Directory(directory))
}

// RepoCommitMessage writes a commit message for the staged changes, or for all changes when nothing is staged,
// with the default model. It only returns text; nothing is committed.
func (e *Project) RepoCommitMessage(ctx context.Context, directory string) (string, error) {
	diff, err := git.StagedDiff(ctx, e.registry.Directory(directory))
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(diff) == "" {
		return "", errorcode.Coded(errorcode.NothingToSummarize, errors.New("there are no changes"))
	}
	ref, ok := e.registry.JobModel("summary")
	if !ok {
		return "", errorcode.Coded(errorcode.ModelRequestFailed, errors.New("no model is configured to write the message"))
	}
	if runes := []rune(diff); len(runes) > 60000 {
		diff = string(runes[:60000])
	}
	text, err := e.registry.CompleteText(ctx, ref, "Write a Git commit message for the changes below: one subject line of at most 72 characters in the imperative mood, with no quotes and no trailing period. Reply with the subject only.", diff, 120)
	if err != nil {
		return "", err
	}
	if subject := conversation.CleanTitleTo(text, 72); subject != "" {
		return subject, nil
	}
	return "", errorcode.Coded(errorcode.ModelRequestFailed, errors.New("the model returned no message"))
}

// CreateWorktree makes the worktree of a key for a conversation, or returns the one that key already has.
func (e *Project) CreateWorktree(ctx context.Context, directory, key, branch string) (code.Worktree, error) {
	return e.CreateWorktreeFrom(ctx, directory, key, branch, "")
}

// CreateWorktreeFrom makes the worktree of a key starting from the given branch, which stays checked out where it is.
func (e *Project) CreateWorktreeFrom(ctx context.Context, directory, key, branch, base string) (code.Worktree, error) {
	return e.worktrees().CreateFrom(ctx, e.registry.Directory(directory), key, branch, base)
}

// ListWorktrees lists the worktrees this engine made for the repository of a directory.
func (e *Project) ListWorktrees(ctx context.Context, directory string) ([]code.Worktree, error) {
	return e.worktrees().List(ctx, e.registry.Directory(directory))
}

// MergeWorktree merges the branch of a conversation worktree into the main folder's branch.
func (e *Project) MergeWorktree(ctx context.Context, path string) error {
	conflicts, err := e.worktrees().Merge(ctx, path)
	if err == nil {
		return nil
	}
	if len(conflicts) > 0 {
		return errorcode.Coded(errorcode.WorktreeMergeConflict, fmt.Errorf("conflicts in %s", strings.Join(conflicts, ", ")))
	}
	if strings.Contains(err.Error(), "not a worktree") {
		return errorcode.Coded(errorcode.WorktreeUnknown, err)
	}
	return err
}

// RemoveWorktree deletes a conversation worktree; its branch stays.
func (e *Project) RemoveWorktree(ctx context.Context, path string) error {
	err := e.worktrees().Remove(ctx, path)
	if err != nil && strings.Contains(err.Error(), "not a worktree") {
		return errorcode.Coded(errorcode.WorktreeUnknown, err)
	}
	return err
}

func (e *Project) worktrees() *code.Worktrees {
	e.worktreeOnce.Do(func() {
		e.worktreeSet = &code.Worktrees{Store: e.core.Store, Home: e.worktreeHome}
	})
	return e.worktreeSet
}

// FileStatus is the Git state of one file.
func (e *Project) FileStatus(ctx context.Context, directory, path string) (code.Status, error) {
	return code.FileStatus(ctx, e.registry.Directory(directory), path)
}

// FileIdentity names the canonical folder and the repository root of a path.
func (e *Project) FileIdentity(ctx context.Context, directory, path string) (code.Identity, error) {
	directory = e.registry.Directory(directory)
	if registry.Missing(directory) {
		return code.Identity{}, errorcode.Coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
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
		if folder.SameDirectory(tree.Path, identity.Root) {
			identity.Worktree = tree.Key
		}
	}
	return identity, nil
}

// FindFiles finds project files by a part of their path.
func (e *Project) FindFiles(ctx context.Context, directory, query string, limit int) ([]string, error) {
	return code.FindFiles(ctx, e.registry.Directory(directory), query, limit)
}

// ReadFile returns a file as the editor shows it; see code.ReadFile.
func (e *Project) ReadFile(ctx context.Context, directory, path string) (FileContent, error) {
	read, err := code.ReadFile(ctx, e.registry.Directory(directory), path)
	if err != nil {
		return FileContent{}, err
	}
	return FileContent{Type: read.Type, Content: read.Content, MIME: read.MIME, Checksum: read.Checksum, Head: read.Head, Missing: read.Missing}, nil
}

// WriteFile saves the text of the editor over the version it read; see code.WriteFile.
func (e *Project) WriteFile(ctx context.Context, directory, path, content, expected string, force bool) (string, error) {
	checksum, err := code.WriteFile(ctx, e.registry.Directory(directory), path, content, expected, force)
	if errors.Is(err, code.ErrChanged) {
		return "", errorcode.Coded(errorcode.FileChanged, err)
	}
	return checksum, err
}

// reviewer is the review of the engine's conversations, made on first use.
func (e *Project) reviewer() *review.Reviewer {
	e.reviewOnce.Do(func() {
		e.reviews = review.New(e.reviewDeps)
	})
	return e.reviews
}

// reviewError gives the errors of a review their codes.
func reviewError(err error) error {
	switch {
	case errors.Is(err, review.ErrStale):
		return errorcode.Coded(errorcode.ReviewStale, err)
	case errors.Is(err, review.ErrNothingToUndo):
		return errorcode.Coded(errorcode.NothingToUndo, err)
	case errors.Is(err, review.ErrNoSuchTurn):
		return errorcode.Coded(errorcode.RevertTargetInvalid, err)
	}
	return err
}

// ReviewAccept makes the current contents of files the starting point of the review of a conversation or one turn.
func (e *Project) ReviewAccept(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	status, err := e.reviewer().Accept(ctx, id, message, files)
	return status, reviewError(err)
}

// ReviewReject puts the starting point of the review back into the working files.
func (e *Project) ReviewReject(ctx context.Context, id, message event.ID, files []review.File) (review.Status, error) {
	status, err := e.reviewer().Reject(ctx, id, message, files)
	return status, reviewError(err)
}

// ReviewUndo takes back the latest accept or reject of a conversation.
func (e *Project) ReviewUndo(ctx context.Context, id event.ID) (review.Status, error) {
	status, err := e.reviewer().Undo(ctx, id)
	return status, reviewError(err)
}

// ReviewStatus tells what the person can undo in a conversation's review.
func (e *Project) ReviewStatus(ctx context.Context, id event.ID) (review.Status, error) {
	status, err := e.reviewer().Status(ctx, id)
	return status, reviewError(err)
}

// SetDirectoryWatchInterval changes how often a watched folder is looked at; tests make it short.
func (e *Project) SetDirectoryWatchInterval(interval time.Duration) {
	e.directoryWatches.SetInterval(interval)
}

// WatchDirectory makes the engine announce what changes in a folder without the engine having done it: a checkout or
// a commit as repo.changed and the files that changed as file.changed. It lasts until the owner lets go with
// UnwatchDirectories, which the server does when the connection of the owner closes. A group watches its own project
// folder through watchGroup; this is for the folders of conversations that no group watches.
func (e *Project) WatchDirectory(ctx context.Context, owner, directory string) error {
	directory = e.registry.Directory(directory)
	if registry.Missing(directory) {
		return errorcode.Coded(errorcode.DirectoryMissing, errors.New("the folder does not exist"))
	}
	return e.directoryWatches.Watch(ctx, folderwatch.Hooks{
		Context: e.core.Ctx,
		Go:      func(run func()) { e.core.Workers.Go(run) },
		Excluded: func(ctx context.Context) []string {
			excluded, _ := e.coordinator.WatchedWorkspaces(ctx)
			return excluded
		},
		Repository: func(ctx context.Context, directory string, changed watch.RepoChanged) {
			e.announceDirectory(ctx, directory, coordinator.RepoChanged, coordinator.RepoChanges{RepoChanged: changed})
		},
		Files: func(ctx context.Context, directory string, paths []string) {
			e.announceDirectory(ctx, directory, coordinator.FileChanged, coordinator.FileChanges{Directory: directory, Paths: paths})
		},
	}, owner, directory)
}

// UnwatchDirectories lets go of every folder the owner watches.
func (e *Project) UnwatchDirectories(owner string) { e.directoryWatches.Unwatch(owner) }

// announceDirectory publishes a change of a folder on the stream of that folder; it belongs to no session or group.
func (e *Project) announceDirectory(ctx context.Context, directory string, kind event.Type, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = e.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("watch:" + directory), Actor: event.Actor{Kind: event.ActorSystem, ID: "watch"}, Type: kind, Payload: body})
}

func (e *Project) ListTerminals(directory string) []terminal.Info {
	return e.terminals.List(directory)
}

func (e *Project) CreateTerminal(ctx context.Context, options terminal.CreateOptions) (terminal.Info, error) {
	return e.terminals.Create(ctx, options)
}

func (e *Project) Terminal(id event.ID) (terminal.Info, error) {
	return e.terminals.Get(id)
}

func (e *Project) RemoveTerminal(ctx context.Context, id event.ID) error {
	return e.terminals.Remove(ctx, id)
}

func (e *Project) UpdateTerminal(ctx context.Context, id event.ID, options terminal.UpdateOptions) (terminal.Info, error) {
	return e.terminals.Update(ctx, id, options)
}

func (e *Project) SubscribeTerminal(id event.ID, cursor uint64) (*terminal.Subscription, error) {
	return e.terminals.Subscribe(id, cursor)
}

func (e *Project) WriteTerminal(id event.ID, body []byte) error {
	return e.terminals.Write(id, body)
}
