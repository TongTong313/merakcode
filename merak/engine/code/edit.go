package code

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/internal/platform/git"
)

// ErrChanged says a file no longer has the version the editor read.
var ErrChanged = errors.New("the file changed on disk")

// A reply must fit the transport's four MiB frame, and base64 adds a third.
const replyLimit = 3 << 20

// Read is a file as the editor shows it.
type Read struct {
	Type     string
	Content  string
	MIME     string
	Checksum string
	// Head is the text of the last commit; nil when the file is not tracked.
	Head *string
	// Missing marks a tracked file deleted from disk; Content is then its last committed text.
	Missing bool
}

// Checksum names the exact bytes of a file.
func Checksum(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

// Inside resolves a path of a folder and refuses anything that leaves it or touches Git's own data.
func Inside(directory, name string) (string, string, error) {
	absolute := name
	if !filepath.IsAbs(absolute) {
		absolute = filepath.Join(directory, name)
	}
	relative, err := filepath.Rel(directory, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", errors.New("a file must be inside the folder")
	}
	if relative == ".git" || strings.HasPrefix(filepath.ToSlash(relative), ".git/") {
		return "", "", errors.New("Git's own files cannot be edited")
	}
	return absolute, filepath.ToSlash(relative), nil
}

// ReadFile returns a file as the editor shows it: text with its checksum and last committed version, an image or
// document as base64, any other binary file by type only. A tracked file deleted from disk comes back as its last
// committed version, marked missing.
func ReadFile(ctx context.Context, directory, name string) (Read, error) {
	if err := ctx.Err(); err != nil {
		return Read{}, err
	}
	absolute := name
	if !filepath.IsAbs(absolute) {
		absolute = filepath.Join(directory, name)
	}
	relative, relativeErr := filepath.Rel(directory, absolute)
	data, err := os.ReadFile(absolute)
	if errors.Is(err, fs.ErrNotExist) {
		// A tracked file deleted from disk stays readable as its last committed text
		if relativeErr == nil {
			if head, ok := git.Head(ctx, directory, relative); ok && len(head) <= replyLimit {
				return Read{Type: "text", Content: head, Missing: true}, nil
			}
		}
	}
	if err != nil {
		return Read{}, errors.New("file read failed")
	}
	result := Read{Checksum: Checksum(data)}
	mime := http.DetectContentType(data)
	switch {
	case mime == "image/png" || mime == "image/jpeg" || mime == "image/webp" || mime == "image/gif" || mime == "application/pdf":
		result.Type, result.MIME = "binary", mime
		if len(data) <= replyLimit*3/4 {
			result.Content = base64.StdEncoding.EncodeToString(data)
		}
	case utf8.Valid(data) && !strings.ContainsRune(string(data), 0) && len(data) <= replyLimit:
		result.Type, result.Content = "text", string(data)
		if relativeErr == nil {
			if head, ok := git.Head(ctx, directory, relative); ok && len(head) <= replyLimit {
				result.Head = &head
			}
		}
	default:
		result.Type = "binary"
	}
	return result, nil
}

// WriteFile replaces a file with the text the editor holds and returns the checksum of what it wrote. When the
// editor knows the checksum of the version it read, the file must still have it, so an outside change is never
// overwritten silently; force skips that check.
func WriteFile(ctx context.Context, directory, name, content, expected string, force bool) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	absolute, _, err := Inside(directory, name)
	if err != nil {
		return "", err
	}
	mode := fs.FileMode(0o644)
	current, err := os.ReadFile(absolute)
	switch {
	case err == nil:
		if info, statErr := os.Stat(absolute); statErr == nil {
			mode = info.Mode().Perm()
		}
		if expected != "" && !force && Checksum(current) != expected {
			return "", ErrChanged
		}
	case errors.Is(err, fs.ErrNotExist):
		if expected != "" && !force {
			return "", ErrChanged
		}
	default:
		return "", errors.New("file read failed")
	}
	temporary, err := os.CreateTemp(filepath.Dir(absolute), ".merak-save-*")
	if err != nil {
		return "", errors.New("file write failed")
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.WriteString(content); err != nil {
		temporary.Close()
		return "", errors.New("file write failed")
	}
	if err := temporary.Close(); err != nil {
		return "", errors.New("file write failed")
	}
	if err := os.Chmod(temporary.Name(), mode); err != nil {
		return "", errors.New("file write failed")
	}
	if err := os.Rename(temporary.Name(), absolute); err != nil {
		return "", errors.New("file write failed")
	}
	return Checksum([]byte(content)), nil
}
