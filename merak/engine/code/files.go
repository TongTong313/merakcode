package code

import (
	"context"
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/workspace"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

// Status is the Git state of one file; Status is empty when the file is clean.
type Status struct {
	Path   string `json:"path"`
	Status string `json:"status,omitempty"`
	Staged bool   `json:"staged,omitempty"`
}

// Identity says which folder and which repository a path belongs to, whatever way the folder was written.
type Identity struct {
	// Directory is the one form of the folder that was asked about.
	Directory string `json:"directory"`
	// Root is the top of the Git repository that holds it; empty when the folder is not in one.
	Root string `json:"root,omitempty"`
	Path string `json:"path"`
}

func relative(name string) string { return path.Clean(filepath.ToSlash(name)) }

// FileStatus reports the state of one file of a folder.
func FileStatus(ctx context.Context, directory, name string) (Status, error) {
	name = relative(name)
	if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
		return Status{}, errors.New("a file must be inside the folder")
	}
	state, err := git.Status(ctx, directory)
	if err != nil {
		return Status{}, err
	}
	for _, file := range state.Files {
		if relative(file.Path) == name {
			return Status{Path: name, Status: file.Status, Staged: file.Staged}, nil
		}
	}
	return Status{Path: name}, nil
}

// FileIdentity names the canonical folder and the repository root of a path.
func FileIdentity(ctx context.Context, directory, name string) (Identity, error) {
	canonical, err := workspace.Canonical(directory)
	if err != nil {
		return Identity{}, err
	}
	identity := Identity{Directory: canonical, Path: relative(name)}
	if root, err := git.Root(ctx, canonical); err == nil {
		if identity.Root, err = workspace.Canonical(root); err != nil {
			return Identity{}, err
		}
	}
	return identity, nil
}

// FindFiles returns up to limit project files whose path contains the query, ignoring case. In a Git repository
// the files are the tracked and the new ones, never the ignored ones; elsewhere every file except under .git.
func FindFiles(ctx context.Context, directory, query string, limit int) ([]string, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	candidates, err := git.ListFiles(ctx, directory)
	if err != nil {
		candidates = nil
		walkErr := filepath.WalkDir(directory, func(p string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() && entry.Name() == ".git" {
				return filepath.SkipDir
			}
			if !entry.IsDir() {
				if rel, err := filepath.Rel(directory, p); err == nil {
					candidates = append(candidates, filepath.ToSlash(rel))
				}
			}
			return ctx.Err()
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}
	found := []string{}
	for _, candidate := range candidates {
		if limit > 0 && len(found) == limit {
			break
		}
		if strings.Contains(strings.ToLower(candidate), query) {
			found = append(found, filepath.ToSlash(candidate))
		}
	}
	return found, nil
}
