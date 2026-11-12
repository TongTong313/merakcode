package git

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type Change struct {
	File
	Before  string `json:"before"`
	After   string `json:"after"`
	Binary  bool   `json:"binary"`
	Version string `json:"version"`
}

// NewChange describes how a file went from its before to its after contents. The version names that pair, so a
// client that read one version can tell the pair has changed since.
func NewChange(file File, before, after []byte) Change {
	version := sha256.New()
	version.Write(before)
	version.Write([]byte{0})
	version.Write(after)
	change := Change{File: file, Version: fmt.Sprintf("%x", version.Sum(nil))}
	change.Binary = bytes.ContainsRune(before, 0) || bytes.ContainsRune(after, 0) || !utf8.Valid(before) || !utf8.Valid(after)
	if !change.Binary {
		change.Before, change.After = string(before), string(after)
	}
	return change
}

// BytesAt reads a file as it was at a commit; a file that did not exist there, or an empty base, reads as absent.
func BytesAt(ctx context.Context, directory, base, name string) ([]byte, bool, error) {
	if base == "" {
		return nil, false, nil
	}
	prefix, err := run(ctx, directory, "rev-parse", "--show-prefix")
	if err != nil {
		return nil, false, err
	}
	if _, err := run(ctx, directory, "cat-file", "-e", base+":"+strings.TrimSpace(string(prefix))+name); err != nil {
		return nil, false, nil
	}
	body, err := run(ctx, directory, "show", base+":"+strings.TrimSpace(string(prefix))+name)
	return body, err == nil, err
}

func Diff(ctx context.Context, directory, base string) ([]Change, error) {
	var resolved []byte
	var err error
	if base == "" {
		resolved, err = run(ctx, directory, "hash-object", "-t", "tree", "--stdin")
	} else {
		resolved, err = run(ctx, directory, "rev-parse", "--verify", "--end-of-options", base+"^{commit}")
	}
	if err != nil {
		return nil, err
	}
	base = strings.TrimSpace(string(resolved))
	prefix, err := run(ctx, directory, "rev-parse", "--show-prefix")
	if err != nil {
		return nil, err
	}
	rootPrefix := strings.TrimSpace(string(prefix))
	body, err := run(ctx, directory, "diff", "--no-ext-diff", "--no-textconv", "--relative", "--name-status", "-z", "--find-renames", base, "--")
	if err != nil {
		return nil, err
	}
	entries := strings.Split(string(body), "\x00")
	files := []File{}
	for i := 0; i+1 < len(entries); {
		code, name := entries[i], entries[i+1]
		i += 2
		if code == "" {
			continue
		}
		file := File{Path: name, Status: "modified"}
		switch code[0] {
		case 'A':
			file.Status = "added"
		case 'D':
			file.Status = "deleted"
		case 'R', 'C':
			file.Status = "renamed"
			file.OldPath = name
			if i < len(entries) {
				file.Path = entries[i]
				i++
			}
		}
		files = append(files, file)
	}
	untracked, err := run(ctx, directory, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	for _, path := range strings.Split(string(untracked), "\x00") {
		if path != "" {
			files = append(files, File{Path: path, Status: "untracked"})
		}
	}
	result := make([]Change, 0, len(files))
	remaining := responseBudget - 2
	for _, file := range files {
		var before, after []byte
		if file.Status != "added" && file.Status != "untracked" {
			name := file.Path
			if file.OldPath != "" {
				name = file.OldPath
			}
			before, err = run(ctx, directory, "show", base+":"+rootPrefix+name)
			if err != nil {
				return nil, err
			}
		}
		if file.Status != "deleted" {
			path := filepath.Join(directory, filepath.FromSlash(file.Path))
			info, statErr := os.Lstat(path)
			if statErr != nil {
				return nil, statErr
			}
			if info.Mode()&os.ModeSymlink != 0 {
				var target string
				target, err = os.Readlink(path)
				after = []byte(target)
			} else {
				var source *os.File
				source, err = os.Open(path)
				if err == nil {
					after, err = io.ReadAll(io.LimitReader(source, responseBudget+1))
					_ = source.Close()
					if len(after) > responseBudget {
						return nil, errors.New("repository file exceeds its limit")
					}
				}
			}
			if err != nil {
				return nil, err
			}
		}
		change := NewChange(file, before, after)
		encoded, _ := json.Marshal(change)
		remaining -= len(encoded) + 1
		if remaining < 0 {
			return nil, errors.New("repository diff exceeds its limit")
		}
		result = append(result, change)
	}
	return result, nil
}
