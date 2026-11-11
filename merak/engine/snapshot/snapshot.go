// Package snapshot records the files of a workspace in a shadow Git repository that lives outside the project, so
// a conversation can put its files back to an earlier moment. The project's own repository is never touched, and
// files its .gitignore excludes are neither recorded nor restored.
package snapshot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

// Repo is a shadow repository for one workspace.
type Repo struct {
	// GitDir is the shadow repository; it is created on first use.
	GitDir string
	// Workdir is the directory whose files are recorded.
	Workdir string
}

func (r Repo) git(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	if err := os.MkdirAll(r.GitDir, 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(r.GitDir, "HEAD")); err != nil {
		if out, initErr := r.run(ctx, false, nil, "init", "--bare", "--quiet", r.GitDir); initErr != nil {
			return nil, fmt.Errorf("shadow repository: %w: %s", initErr, out)
		}
	}
	return r.run(ctx, true, stdin, args...)
}

func (r Repo) run(ctx context.Context, shadow bool, stdin []byte, args ...string) ([]byte, error) {
	cmd := process.Command(ctx, r.Workdir, "git", append([]string{"--no-optional-locks", "-c", "core.quotepath=false", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.fsmonitor=false"}, args...)...)
	var env []string
	for _, entry := range cmd.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE":
		default:
			env = append(env, entry)
		}
	}
	cmd.Env = env
	if shadow {
		cmd.Env = append(env, "GIT_DIR="+r.GitDir, "GIT_WORK_TREE="+r.Workdir)
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, failure bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &failure
	if err := cmd.Run(); err != nil {
		return failure.Bytes(), err
	}
	return out.Bytes(), nil
}

// Track records the workspace as it is now and returns the tree that identifies it.
func (r Repo) Track(ctx context.Context) (string, error) {
	if out, err := r.git(ctx, nil, "add", "-A", "--", "."); err != nil {
		return "", fmt.Errorf("track workspace: %w: %s", err, out)
	}
	tree, err := r.git(ctx, nil, "write-tree")
	if err != nil {
		return "", fmt.Errorf("track workspace: %w", err)
	}
	return strings.TrimSpace(string(tree)), nil
}

// Restore puts the workspace back to a tree returned by Track: files that changed or were deleted since come back,
// files made since are removed.
func (r Repo) Restore(ctx context.Context, tree string) error {
	if tree == "" {
		return errors.New("restore needs a tree")
	}
	current, err := r.Track(ctx)
	if err != nil || current == tree {
		return err
	}
	diff, err := r.git(ctx, nil, "diff-tree", "-r", "-z", "--no-renames", "--name-status", tree, current)
	if err != nil {
		return fmt.Errorf("compare workspace: %w", err)
	}
	fields := bytes.Split(bytes.TrimSuffix(diff, []byte{0}), []byte{0})
	var restore bytes.Buffer
	for i := 0; i+1 < len(fields); i += 2 {
		status, path := string(fields[i]), string(fields[i+1])
		if status == "A" { // present now, absent in the tree
			full := filepath.Join(r.Workdir, filepath.FromSlash(path))
			if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
				return err
			}
			r.pruneEmpty(filepath.Dir(full))
			continue
		}
		restore.WriteString(path)
		restore.WriteByte(0)
	}
	if out, err := r.git(ctx, nil, "read-tree", tree); err != nil {
		return fmt.Errorf("restore workspace: %w: %s", err, out)
	}
	if restore.Len() == 0 {
		return nil
	}
	if out, err := r.git(ctx, restore.Bytes(), "checkout-index", "-f", "-z", "--stdin"); err != nil {
		return fmt.Errorf("restore workspace: %w: %s", err, out)
	}
	return nil
}

// pruneEmpty removes directories that a removed file left empty, never the workspace itself.
func (r Repo) pruneEmpty(dir string) {
	for dir != r.Workdir && strings.HasPrefix(dir, r.Workdir) {
		if os.Remove(dir) != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}
