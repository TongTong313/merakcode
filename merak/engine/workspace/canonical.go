package workspace

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
)

// Canonical gives every spelling of a directory one form: absolute, cleaned, without a closing separator, links
// resolved when the directory exists and, on Windows, with an upper-case drive letter. A directory that does not
// exist still has a form, so it can be compared and reported.
func Canonical(directory string) (string, error) {
	if strings.TrimSpace(directory) == "" {
		return "", errors.New("a directory is required")
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	}
	absolute = resolveJunctions(absolute)
	absolute = filepath.Clean(absolute)
	if runtime.GOOS == "windows" && len(absolute) >= 2 && absolute[1] == ':' {
		absolute = strings.ToUpper(absolute[:1]) + absolute[1:]
	}
	return absolute, nil
}

// SameDirectory says whether two spellings name one directory. Windows compares without regard to case.
func SameDirectory(a, b string) bool {
	left, err := Canonical(a)
	if err != nil {
		return false
	}
	right, err := Canonical(b)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}
