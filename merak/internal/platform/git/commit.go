package git

import (
	"context"
	"errors"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// cleanPaths accepts only paths inside the repository, written relative to the directory.
func cleanPaths(paths []string) ([]string, error) {
	cleaned := make([]string, 0, len(paths))
	for _, p := range paths {
		slashed := filepath.ToSlash(p)
		if slashed == "" || filepath.IsAbs(p) || strings.HasPrefix(slashed, "/") || strings.HasPrefix(slashed, "-") ||
			path.Clean(slashed) == ".." || strings.HasPrefix(path.Clean(slashed), "../") {
			return nil, errors.New("a path to commit must stay inside the repository")
		}
		cleaned = append(cleaned, path.Clean(slashed))
	}
	return cleaned, nil
}

// CommitChanges records the working changes in one commit and returns its id. With paths it records only those
// files and leaves every other change as it was; without them it records everything, new files included.
func CommitChanges(ctx context.Context, directory, message string, paths []string) (string, error) {
	if strings.TrimSpace(message) == "" {
		return "", errors.New("a commit needs a message")
	}
	cleaned, err := cleanPaths(paths)
	if err != nil {
		return "", err
	}
	if len(cleaned) == 0 {
		if _, err := run(ctx, directory, "add", "-A", "--", "."); err != nil {
			return "", err
		}
		staged, err := run(ctx, directory, "diff", "--cached", "--name-only")
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(string(staged)) == "" {
			return "", errors.New("there is nothing to commit")
		}
		if _, err := run(ctx, directory, "commit", "--quiet", "-m", message); err != nil {
			return "", err
		}
		return Current(ctx, directory)
	}
	if _, err := run(ctx, directory, append([]string{"add", "--"}, cleaned...)...); err != nil {
		return "", err
	}
	changed, err := run(ctx, directory, append([]string{"diff", "--cached", "--name-only", "--"}, cleaned...)...)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(changed)) == "" {
		return "", errors.New("there is nothing to commit in these files")
	}
	if _, err := run(ctx, directory, append([]string{"commit", "--quiet", "-m", message, "--only", "--"}, cleaned...)...); err != nil {
		return "", err
	}
	return Current(ctx, directory)
}

// StagedDiff returns the text of what a commit would record: the staged changes, or every change when nothing is
// staged. It is what a model reads to propose a commit message.
func StagedDiff(ctx context.Context, directory string) (string, error) {
	body, err := run(ctx, directory, "diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(string(body)) != "" {
		return string(body), nil
	}
	body, err = run(ctx, directory, "diff", "--no-color", "--no-ext-diff", "--unified=3")
	return string(body), err
}

// Push sends the current branch to its remote and remembers it as the upstream; without a configured remote it
// fails. The remote is origin, or the first one alphabetically.
func Push(ctx context.Context, directory string) error {
	branch, err := run(ctx, directory, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || strings.TrimSpace(string(branch)) == "" {
		return errors.New("push needs a branch")
	}
	remotes, err := Remotes(ctx, directory)
	if err != nil {
		return err
	}
	if len(remotes) == 0 {
		return errors.New("the repository has no remote")
	}
	remote := "origin"
	if _, ok := remotes[remote]; !ok {
		names := make([]string, 0, len(remotes))
		for name := range remotes {
			names = append(names, name)
		}
		slices.Sort(names)
		remote = names[0]
	}
	_, err = run(ctx, directory, "push", "--set-upstream", "--", remote, "HEAD")
	return err
}

// Worktree is one checked-out copy of a repository.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
	Head   string `json:"head"`
	// Main is the first worktree of the repository, the one that holds its .git folder.
	Main bool `json:"main"`
}

// Worktrees lists the worktrees of the repository of a directory, the main one first.
func Worktrees(ctx context.Context, directory string) ([]Worktree, error) {
	body, err := run(ctx, directory, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	var trees []Worktree
	var current *Worktree
	for _, field := range strings.Split(string(body), "\x00") {
		switch {
		case strings.HasPrefix(field, "worktree "):
			trees = append(trees, Worktree{Path: filepath.FromSlash(strings.TrimPrefix(field, "worktree ")), Main: len(trees) == 0})
			current = &trees[len(trees)-1]
		case current == nil:
		case strings.HasPrefix(field, "HEAD "):
			current.Head = strings.TrimPrefix(field, "HEAD ")
		case strings.HasPrefix(field, "branch "):
			current.Branch = strings.TrimPrefix(strings.TrimPrefix(field, "branch "), "refs/heads/")
		}
	}
	return trees, nil
}

// Merge brings a branch into the branch checked out in the directory. A merge that cannot finish is undone and
// reported with the conflicting files.
func Merge(ctx context.Context, directory, branch string) ([]string, error) {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", branch); err != nil {
		return nil, err
	}
	status, err := Status(ctx, directory)
	if err != nil {
		return nil, err
	}
	for _, file := range status.Files {
		if file.Status != "untracked" {
			return nil, errors.New("the target folder has uncommitted changes")
		}
	}
	if _, err := run(ctx, directory, "merge", "--no-edit", "--", branch); err != nil {
		conflicts, listErr := run(ctx, directory, "diff", "--name-only", "--diff-filter=U")
		_, _ = run(ctx, directory, "merge", "--abort")
		var files []string
		if listErr == nil {
			files = strings.Fields(string(conflicts))
		}
		return files, err
	}
	return nil, nil
}

// Ignored reports whether the repository ignores a path.
func Ignored(ctx context.Context, directory, name string) bool {
	_, err := run(ctx, directory, "check-ignore", "--quiet", "--", name)
	return err == nil
}

// ListFiles returns the files a person would call the project's: tracked and new ones, never ignored ones.
func ListFiles(ctx context.Context, directory string) ([]string, error) {
	body, err := run(ctx, directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ".")
	if err != nil {
		return nil, err
	}
	var files []string
	for _, name := range strings.Split(string(body), "\x00") {
		if name != "" {
			files = append(files, name)
		}
	}
	return files, nil
}
