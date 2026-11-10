package git

import (
	"context"
	"errors"
	"slices"
	"strings"
)

func Remotes(ctx context.Context, directory string) (map[string]string, error) {
	body, err := run(ctx, directory, "remote")
	if err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, name := range strings.Fields(string(body)) {
		url, err := run(ctx, directory, "remote", "get-url", name)
		if err != nil {
			return nil, err
		}
		result[name] = strings.TrimSpace(string(url))
	}
	return result, nil
}

func ProjectRemote(ctx context.Context, directory, selected string) (string, error) {
	remotes, err := Remotes(ctx, directory)
	if err != nil {
		return "", err
	}
	if selected != "" {
		for _, url := range remotes {
			if url == selected {
				return url, nil
			}
		}
		return "", errors.New("project remote is not configured in its checkout")
	}
	if remotes["origin"] != "" {
		return remotes["origin"], nil
	}
	var names []string
	for name := range remotes {
		names = append(names, name)
	}
	slices.Sort(names)
	if len(names) == 0 {
		return "", nil
	}
	return remotes[names[0]], nil
}

func Fetch(ctx context.Context, directory, remote string) error {
	if remote == "" {
		return errors.New("repository remote is required")
	}
	_, err := run(ctx, directory, "fetch", "--", remote)
	return err
}

func FetchBranch(ctx context.Context, directory, remote, branch string) (string, error) {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", branch); err != nil {
		return "", err
	}
	if _, err := run(ctx, directory, "fetch", "--", remote, "refs/heads/"+branch); err != nil {
		return "", err
	}
	return Commit(ctx, directory, "FETCH_HEAD")
}

func PushBranch(ctx context.Context, directory, remote, branch string, remove bool) error {
	if _, err := run(ctx, directory, "check-ref-format", "--branch", branch); err != nil {
		return err
	}
	ref := "refs/heads/" + branch
	source := ref
	if remove {
		source = ""
	}
	_, err := run(ctx, directory, "push", "--", remote, source+":"+ref)
	return err
}
