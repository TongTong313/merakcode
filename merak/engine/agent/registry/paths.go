package registry

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/engine/infra/folder"
)

func (e *Registry) directory(directory string) string {
	if directory == "" {
		return CanonicalDirectory(e.core.Workdir)
	}
	return CanonicalDirectory(directory)
}

// CanonicalDirectory gives the folder of a request its one form, so every spelling of it reaches the same
// workspace. A folder that does not exist keeps its cleaned spelling and is reported by the call that needs it.
func CanonicalDirectory(directory string) string {
	if directory == "" {
		return ""
	}
	if canonical, err := folder.Canonical(directory); err == nil {
		return canonical
	}
	return directory
}

// Directory returns the canonical folder of a request; an empty one is the engine's own folder.
func (e *Registry) Directory(directory string) string { return e.directory(directory) }

// Missing says the folder of a request is gone; an empty one means the engine's own folder.
func Missing(directory string) bool {
	if directory == "" {
		return false
	}
	_, err := os.Stat(directory)
	return errors.Is(err, fs.ErrNotExist)
}

func ResolvedSandboxPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if !os.IsNotExist(err) || filepath.Dir(absolute) == absolute {
		return "", err
	}
	parent, err := ResolvedSandboxPath(filepath.Dir(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(absolute)), nil
}
