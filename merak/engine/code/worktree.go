// Package code holds what the code panels of a client need from a project folder: worktrees of a conversation,
// the status and the identity of a file, and finding files. Everything here goes through Git and the file system;
// nothing runs a model.
package code

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

const worktreeKind = "chat-worktree"

// Worktree is a checked-out copy of a repository that one conversation works in.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	// Key is what the client gave to ask for this worktree; asking again with it returns the same one.
	Key string `json:"key"`
	// Root is the repository the worktree belongs to.
	Root string `json:"root"`
}

// Worktrees makes and tracks the worktrees of conversations. It remembers each one by a document, so a client
// that lost a response can ask again and not get a second copy.
type Worktrees struct {
	Store store.Store
	// Home is the folder that holds the worktrees.
	Home string
	mu   sync.Mutex
}

var unsafeBranch = regexp.MustCompile(`[^A-Za-z0-9._/-]+`)

func docKey(root, key string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(root) + "\x00" + key))
	return hex.EncodeToString(sum[:16])
}

// Create makes the worktree of a key, or returns the one that already exists for it. A branch name is optional;
// without one the branch is named after the key.
func (w *Worktrees) Create(ctx context.Context, directory, key, branch string) (Worktree, error) {
	return w.CreateFrom(ctx, directory, key, branch, "")
}

// CreateFrom is Create with the branch the new worktree starts from; without one it starts from the current head.
func (w *Worktrees) CreateFrom(ctx context.Context, directory, key, branch, base string) (Worktree, error) {
	if strings.TrimSpace(key) == "" {
		return Worktree{}, errors.New("a worktree needs a key")
	}
	root, err := git.ProjectRoot(ctx, directory)
	if err != nil {
		return Worktree{}, errors.New("the folder is not a Git repository")
	}
	root, err = workspace.Canonical(root)
	if err != nil {
		return Worktree{}, err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	name := docKey(root, key)
	if doc, err := w.Store.Fetch(ctx, worktreeKind, name); err == nil {
		var existing Worktree
		if json.Unmarshal(doc.Body, &existing) == nil {
			if _, statErr := os.Stat(existing.Path); statErr == nil {
				return existing, nil
			}
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return Worktree{}, err
	}
	if branch == "" {
		branch = "merak/chat/" + strings.Trim(unsafeBranch.ReplaceAllString(key, "-"), "-")
	}
	path := filepath.Join(w.Home, "worktrees", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Worktree{}, err
	}
	head, err := git.Current(ctx, root)
	if err != nil {
		return Worktree{}, err
	}
	branches, err := git.Branches(ctx, root)
	if err != nil {
		return Worktree{}, err
	}
	exists := false
	for _, known := range branches {
		exists = exists || known.Name == branch
	}
	if base != "" {
		found := false
		for _, known := range branches {
			found = found || known.Name == base
		}
		if !found {
			return Worktree{}, errors.New("the starting branch does not exist")
		}
		if head, err = git.Commit(ctx, root, base); err != nil {
			return Worktree{}, err
		}
	}
	if !exists {
		if err := git.CreateBranch(ctx, root, branch, head); err != nil {
			return Worktree{}, err
		}
	}
	_ = os.RemoveAll(path)
	if err := git.AddWorktree(ctx, root, path, branch); err != nil {
		return Worktree{}, err
	}
	made := Worktree{Path: path, Branch: branch, Key: key, Root: root}
	body, err := json.Marshal(made)
	if err != nil {
		return Worktree{}, err
	}
	var rev uint64
	if doc, err := w.Store.Fetch(ctx, worktreeKind, name); err == nil {
		rev = doc.Rev
	}
	return made, w.Store.Put(ctx, store.Doc{Kind: worktreeKind, Key: name, Rev: rev, Body: body})
}

// List returns the worktrees of the repository of a directory that this engine made.
func (w *Worktrees) List(ctx context.Context, directory string) ([]Worktree, error) {
	root, err := git.ProjectRoot(ctx, directory)
	if err != nil {
		return nil, errors.New("the folder is not a Git repository")
	}
	if root, err = workspace.Canonical(root); err != nil {
		return nil, err
	}
	all, err := w.All(ctx)
	if err != nil {
		return nil, err
	}
	result := []Worktree{}
	for _, tree := range all {
		if workspace.SameDirectory(tree.Root, root) {
			result = append(result, tree)
		}
	}
	return result, nil
}

// All returns every worktree this engine made.
func (w *Worktrees) All(ctx context.Context) ([]Worktree, error) {
	metas, err := w.Store.List(ctx, worktreeKind, "")
	if err != nil {
		return nil, err
	}
	var trees []Worktree
	for _, meta := range metas {
		doc, err := w.Store.Fetch(ctx, worktreeKind, meta.Key)
		if err != nil {
			continue
		}
		var tree Worktree
		if json.Unmarshal(doc.Body, &tree) == nil {
			trees = append(trees, tree)
		}
	}
	return trees, nil
}

func (w *Worktrees) known(ctx context.Context, path string) (Worktree, string, error) {
	all, err := w.All(ctx)
	if err != nil {
		return Worktree{}, "", err
	}
	for _, tree := range all {
		if workspace.SameDirectory(tree.Path, path) {
			return tree, docKey(tree.Root, tree.Key), nil
		}
	}
	return Worktree{}, "", errors.New("this folder is not a worktree of a conversation")
}

// Merge brings the branch of a worktree into the branch checked out in the repository's main folder. Conflicts
// leave both sides as they were.
func (w *Worktrees) Merge(ctx context.Context, path string) ([]string, error) {
	tree, _, err := w.known(ctx, path)
	if err != nil {
		return nil, err
	}
	return git.Merge(ctx, tree.Root, tree.Branch)
}

// Remove deletes the worktree folder and forgets it. Its branch stays, so no work is lost.
func (w *Worktrees) Remove(ctx context.Context, path string) error {
	tree, name, err := w.known(ctx, path)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := git.DiscardWorktree(ctx, tree.Root, tree.Path); err != nil {
		if _, statErr := os.Stat(tree.Path); statErr == nil {
			return err
		}
	}
	return w.Store.Delete(ctx, worktreeKind, name)
}
