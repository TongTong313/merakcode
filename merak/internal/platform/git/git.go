// Package git provides repository operations for desktop panels and claim worktrees.
package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type File struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
	Staged  bool   `json:"staged"`
}

type State struct {
	Branch string `json:"branch"`
	Head   string `json:"head"`
	Files  []File `json:"files"`
}

// Keep repository replies below the transport's four MiB frame limit.
const responseBudget = 3 << 20

type outputBuffer struct {
	bytes.Buffer
	cancel context.CancelFunc
}

func (b *outputBuffer) Write(body []byte) (int, error) {
	if b.Len()+len(body) > responseBudget {
		b.cancel()
		return 0, errors.New("repository output exceeds its limit")
	}
	return b.Buffer.Write(body)
}

func run(ctx context.Context, directory string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := process.Command(ctx, directory, "git", append([]string{"--no-optional-locks", "-c", "core.quotepath=false"}, args...)...)
	environment := cmd.Environ()
	cmd.Env = nil
	for _, entry := range environment {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE":
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	output := &outputBuffer{cancel: cancel}
	cmd.Stdout = output
	err := cmd.Run()
	if err != nil {
		return nil, fmt.Errorf("git operation failed: %w", err)
	}
	return output.Bytes(), nil
}

func Status(ctx context.Context, directory string) (State, error) {
	body, err := run(ctx, directory, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".")
	if err != nil {
		return State{}, err
	}
	prefix, err := run(ctx, directory, "rev-parse", "--show-prefix")
	if err != nil {
		return State{}, err
	}
	rootPrefix := strings.TrimSpace(string(prefix))
	state := State{Files: []File{}}
	branch, _ := run(ctx, directory, "symbolic-ref", "--quiet", "--short", "HEAD")
	state.Branch = strings.TrimSpace(string(branch))
	head, _ := run(ctx, directory, "rev-parse", "--verify", "HEAD")
	state.Head = strings.TrimSpace(string(head))
	entries := strings.Split(string(body), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		code := entry[:2]
		file := File{Path: strings.TrimPrefix(entry[3:], rootPrefix), Status: "modified", Staged: code[0] != ' ' && code[0] != '?'}
		switch {
		case code == "??":
			file.Status = "untracked"
		case strings.Contains(code, "U") || code == "AA" || code == "DD":
			file.Status = "conflicted"
		case strings.Contains(code, "R") || strings.Contains(code, "C"):
			file.Status = "renamed"
			i++
			if i < len(entries) {
				file.OldPath = strings.TrimPrefix(entries[i], rootPrefix)
			}
		case strings.Contains(code, "D"):
			file.Status = "deleted"
		case strings.Contains(code, "A"):
			file.Status = "added"
		}
		state.Files = append(state.Files, file)
	}
	return state, nil
}

type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

func Branches(ctx context.Context, directory string) ([]Branch, error) {
	body, err := run(ctx, directory, "for-each-ref", "--sort=refname", "--format=%(HEAD)%00%(refname:short)", "refs/heads/")
	if err != nil {
		return nil, err
	}
	result := []Branch{}
	for _, line := range strings.Split(strings.TrimSuffix(string(body), "\n"), "\n") {
		current, name, ok := strings.Cut(line, "\x00")
		if ok {
			result = append(result, Branch{Name: name, Current: current == "*"})
		}
	}
	return result, nil
}

func Checkout(ctx context.Context, directory, branch string) error {
	branches, err := Branches(ctx, directory)
	if err != nil {
		return err
	}
	for _, known := range branches {
		if known.Name != branch {
			continue
		}
		_, err := run(ctx, directory, "switch", "--no-guess", "--", branch)
		return err
	}
	return errors.New("unknown local branch")
}

func Current(ctx context.Context, directory string) (string, error) {
	body, err := run(ctx, directory, "rev-parse", "--verify", "HEAD^{commit}")
	return strings.TrimSpace(string(body)), err
}
