package git

import (
	"context"
	"slices"
	"strings"
)

type Refs struct {
	Head   string `json:"head"`
	Branch string `json:"branch"`
	Target string `json:"target"`
}

type Revision struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths"`
}

// References reads commit identities without scanning the working directory.
func References(ctx context.Context, directory, target string) (Refs, error) {
	head, err := Current(ctx, directory)
	if err != nil {
		return Refs{}, err
	}
	branch, _ := run(ctx, directory, "symbolic-ref", "--quiet", "--short", "HEAD")
	refs := Refs{Head: head, Branch: strings.TrimSpace(string(branch))}
	if target != "" {
		refs.Target, err = Commit(ctx, directory, "refs/heads/"+target)
	}
	return refs, err
}

// NewCommits lists commits newly reachable from either observed reference.
func NewCommits(ctx context.Context, directory string, before, after Refs) ([]Revision, error) {
	args := []string{"rev-list", "--reverse", "--end-of-options", after.Head}
	if after.Target != "" {
		args = append(args, after.Target)
	}
	if before.Head != "" {
		args = append(args, "^"+before.Head)
	}
	if before.Target != "" {
		args = append(args, "^"+before.Target)
	}
	body, err := run(ctx, directory, args...)
	if err != nil {
		return nil, err
	}
	revisions := []Revision{}
	for _, id := range strings.Fields(string(body)) {
		changed, err := run(ctx, directory, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-m", "-z", id, "--")
		if err != nil {
			return nil, err
		}
		paths := strings.Split(strings.TrimSuffix(string(changed), "\x00"), "\x00")
		if len(changed) == 0 {
			paths = []string{}
		}
		slices.Sort(paths)
		revisions = append(revisions, Revision{ID: id, Paths: slices.Compact(paths)})
	}
	return revisions, nil
}

func LastChange(ctx context.Context, directory, name string) (string, error) {
	body, err := run(ctx, directory, "log", "-1", "--format=%H", "--", name)
	return strings.TrimSpace(string(body)), err
}

// ClaimCommits reads explicit process attribution, never inferring ownership from timing.
func ClaimCommits(ctx context.Context, directory string) (map[string]string, error) {
	body, err := run(ctx, directory, "log", "-g", "--all", "--max-count=10000", "--format=%H%x00%gs%x00%s", "-z")
	if err != nil {
		return nil, err
	}
	fields := strings.Split(string(body), "\x00")
	owners := map[string]string{}
	for index := 0; index+2 < len(fields); index += 3 {
		delete(owners, fields[index])
		action, marked := strings.CutPrefix(fields[index+1], "merak-claim[")
		if !marked {
			continue
		}
		claim, message, closed := strings.Cut(action, "]")
		// Commits append their subject; reset and fast-forward messages are reference moves.
		if !closed || claim == "" || message != ": "+fields[index+2] || fields[index+2] == "updating HEAD" || fields[index+2] == "updating ORIG_HEAD" || strings.HasPrefix(fields[index+2], "Fast-forward") {
			continue
		}
		if claim != "" {
			owners[fields[index]] = claim
		}
	}
	return owners, nil
}
