// Package watch polls project files and repository references for external changes.
package watch

import (
	"context"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

type Commit = git.Revision

type RepoChanged struct {
	git.Refs
	Directory string   `json:"directory"`
	Commits   []Commit `json:"commits"`
}

type Repository struct {
	directory string
	target    string
	refs      git.Refs
}

func NewRepository(ctx context.Context, directory, target string) (*Repository, error) {
	refs, err := git.References(ctx, directory, target)
	if err != nil {
		return nil, err
	}
	return &Repository{directory: directory, target: target, refs: refs}, nil
}

func (r *Repository) Poll(ctx context.Context) (*RepoChanged, error) {
	refs, err := git.References(ctx, r.directory, r.target)
	if err != nil {
		return nil, err
	}
	if refs == r.refs {
		return nil, nil
	}
	commits, err := git.NewCommits(ctx, r.directory, r.refs, refs)
	if err != nil {
		return nil, err
	}
	r.refs = refs
	return &RepoChanged{Refs: refs, Directory: r.directory, Commits: commits}, nil
}
