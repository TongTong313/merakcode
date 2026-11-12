package code

import (
	"context"
	"errors"
	"io/fs"
	"os"
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
	// Worktree is the key of the worktree the engine made at this folder; empty for any other folder.
	Worktree string `json:"worktree,omitempty"`
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
	identity := Identity{Directory: canonical, Path: diskSpelling(canonical, throughLinks(canonical, underSpelling(directory, relative(name))))}
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

// underSpelling turns an absolute path inside the folder, as the caller spells the folder, into a relative one. This
// works even when the folder is only a link that no longer resolves, or its spelling differs from the canonical one.
func underSpelling(directory, name string) string {
	if !filepath.IsAbs(filepath.FromSlash(name)) {
		return name
	}
	base, err := filepath.Abs(directory)
	if err != nil {
		return name
	}
	inside, err := filepath.Rel(base, filepath.FromSlash(name))
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return name
	}
	return filepath.ToSlash(inside)
}

// throughLinks names a file by the real place of its folder, so a linked folder and its target give one identity.
// The file itself need not exist: the deepest folder that does is resolved and the rest is kept. A link that leads
// out of the root leaves the path as asked.
func throughLinks(root, name string) string {
	if name == "." || name == "" || name == ".." || strings.HasPrefix(name, "../") {
		return name
	}
	full := filepath.FromSlash(name)
	if !filepath.IsAbs(full) {
		full = filepath.Join(root, full)
	}
	existing := filepath.Dir(full)
	for {
		if _, err := os.Stat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return name
		}
		existing = parent
	}
	real, err := workspace.Canonical(existing)
	if err != nil {
		return name
	}
	rest, err := filepath.Rel(existing, full)
	if err != nil {
		return name
	}
	inside, err := filepath.Rel(root, filepath.Join(real, rest))
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return name
	}
	return filepath.ToSlash(inside)
}

// diskSpelling writes a relative path the way the disk spells it: a part that differs from the stored name only in
// case takes the stored spelling, so two spellings of one file get one identity. A part with no
// match, and everything below it, stays as asked; a volume that tells both names apart keeps both.
func diskSpelling(root, name string) string {
	if name == "." || name == "" || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") {
		return name
	}
	parts := strings.Split(name, "/")
	directory := root
	for i, part := range parts {
		if _, err := os.Lstat(filepath.Join(directory, part)); err == nil {
			// The exact spelling exists; on a case-insensitive volume it may still differ from the stored one
			entries, readErr := os.ReadDir(directory)
			if readErr != nil {
				return strings.Join(parts, "/")
			}
			for _, entry := range entries {
				if entry.Name() == part {
					break
				}
				if strings.EqualFold(entry.Name(), part) && sameFile(filepath.Join(directory, entry.Name()), filepath.Join(directory, part)) {
					parts[i] = entry.Name()
					break
				}
			}
			directory = filepath.Join(directory, parts[i])
			continue
		}
		return strings.Join(parts, "/")
	}
	return strings.Join(parts, "/")
}

func sameFile(a, b string) bool {
	left, errA := os.Stat(a)
	right, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(left, right)
}
