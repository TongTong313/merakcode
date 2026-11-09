package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func resolveCommit(ctx context.Context, directory, ref string) (string, error) {
	body, err := run(ctx, directory, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	return strings.TrimSpace(string(body)), err
}

func Commit(ctx context.Context, directory, ref string) (string, error) {
	return resolveCommit(ctx, directory, ref)
}
func CreateBranch(ctx context.Context, directory, name, base string) error {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", name); err != nil {
		return err
	}
	commit, err := resolveCommit(ctx, directory, base)
	if err != nil {
		return err
	}
	_, err = run(ctx, directory, "branch", "--", name, commit)
	return err
}
func AddWorktree(ctx context.Context, directory, path, branch string) error {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", branch); err != nil {
		return err
	}
	_, err := run(ctx, directory, "worktree", "add", "--", path, branch)
	return err
}

func Root(ctx context.Context, directory string) (string, error) {
	body, err := run(ctx, directory, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(strings.TrimSpace(string(body)))
}

func MetadataPath(ctx context.Context, directory, name string) (string, error) {
	body, err := run(ctx, directory, "rev-parse", "--path-format=absolute", "--git-path", name)
	if err != nil {
		return "", err
	}
	return filepath.Clean(strings.TrimSpace(string(body))), nil
}

func ExcludeWorktrees(ctx context.Context, directory string) error {
	body, err := run(ctx, directory, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return err
	}
	info := filepath.Join(strings.TrimSpace(string(body)), "info")
	if err := os.MkdirAll(info, 0700); err != nil {
		return err
	}
	path := filepath.Join(info, "exclude")
	body, err = os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	const rule = "/.merak/worktrees/"
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == rule {
			return nil
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString("\n" + rule + "\n")
	return err
}

func RemoveWorktree(ctx context.Context, directory, path string) error {
	_, err := run(ctx, directory, "worktree", "remove", "--", path)
	return err
}

// Rebase returns conflicts after restoring the original worker branch.
func Rebase(ctx context.Context, directory, target string) ([]string, error) {
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		body, err := run(ctx, directory, "rev-parse", "--git-path", name)
		if err != nil {
			return nil, err
		}
		path := strings.TrimSpace(string(body))
		if !filepath.IsAbs(path) {
			path = filepath.Join(directory, path)
		}
		if _, err := os.Stat(path); err == nil {
			return nil, errors.New("worktree already has a rebase in progress")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	status, err := Status(ctx, directory)
	if err != nil {
		return nil, err
	}
	if len(status.Files) != 0 {
		return nil, errors.New("worker must commit its changes before integration")
	}
	commit, err := resolveCommit(ctx, directory, target)
	if err != nil {
		return nil, err
	}
	if _, err = run(ctx, directory, "rebase", "--no-autostash", commit); err == nil {
		return nil, nil
	}
	ending, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	body, diffErr := run(ending, directory, "diff", "--name-only", "--diff-filter=U", "-z")
	var files []string
	if diffErr == nil {
		for _, path := range strings.Split(string(body), "\x00") {
			if path != "" {
				files = append(files, path)
			}
		}
	}
	_, abortErr := run(ending, directory, "rebase", "--abort")
	if len(files) > 0 && abortErr == nil {
		return files, nil
	}
	return nil, err
}

// FastForward refuses a divergent target and updates the checked-out files with Git.
func FastForward(ctx context.Context, directory, target, source string) error {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", target); err != nil {
		return err
	}
	before, err := resolveCommit(ctx, directory, "refs/heads/"+target)
	if err != nil {
		return err
	}
	commit, err := resolveCommit(ctx, directory, source)
	if err != nil {
		return err
	}
	if _, err := run(ctx, directory, "merge-base", "--is-ancestor", before, commit); err != nil {
		return errors.New("target cannot fast-forward to the source")
	}
	body, err := run(ctx, directory, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return err
	}
	path := ""
	for _, line := range strings.Split(string(body), "\x00") {
		if strings.HasPrefix(line, "worktree ") {
			path = strings.TrimPrefix(line, "worktree ")
		}
		if line != "branch refs/heads/"+target {
			continue
		}
		current, err := Status(ctx, path)
		if err != nil {
			return err
		}
		if len(current.Files) != 0 {
			return errors.New("target worktree has uncommitted changes")
		}
		_, err = run(ctx, path, "merge", "--ff-only", "--no-edit", commit)
		return err
	}
	_, err = run(ctx, directory, "update-ref", "--no-deref", "refs/heads/"+target, commit, before)
	return err
}
