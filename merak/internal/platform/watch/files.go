package watch

import (
	"context"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

type Overload struct {
	Files    int           `json:"files"`
	Duration time.Duration `json:"duration"`
}

type FileScan struct {
	Paths    []string
	Overload *Overload
}

type stamp struct {
	modified time.Time
	size     int64
}

type Files struct {
	directory        string
	excluded         []string
	previousExcluded []string
	previous         map[string]stamp
	flagged          bool
}

func NewFiles(directory string, excluded []string) *Files {
	return &Files{directory: directory, excluded: slices.Clone(excluded)}
}

func (f *Files) SetExcluded(directories []string) {
	f.excluded = slices.Clone(directories)
}

func excludedPath(name string, directories []string) bool {
	for _, directory := range directories {
		relative, err := filepath.Rel(directory, name)
		if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func (f *Files) Poll(ctx context.Context) (FileScan, error) {
	started := time.Now()
	count := 0
	var overload *Overload
	current := map[string]stamp{}
	err := filepath.WalkDir(f.directory, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if count > 50000 || time.Since(started) > time.Second {
			overload = &Overload{Files: count, Duration: time.Since(started)}
			return filepath.SkipAll
		}
		if entry.IsDir() {
			if excludedPath(name, f.excluded) {
				return filepath.SkipDir
			}
			if name == f.directory {
				return nil
			}
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == ".merak" || slices.Contains(f.excluded, name) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		count++
		if count > 50000 {
			overload = &Overload{Files: count, Duration: time.Since(started)}
			return filepath.SkipAll
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(f.directory, name)
		if err != nil {
			return err
		}
		current[filepath.ToSlash(relative)] = stamp{modified: info.ModTime(), size: info.Size()}
		return nil
	})
	if err != nil {
		return FileScan{}, err
	}
	if overload == nil && time.Since(started) > time.Second {
		overload = &Overload{Files: count, Duration: time.Since(started)}
	}
	if overload != nil {
		if f.flagged {
			return FileScan{}, nil
		}
		f.flagged = true
		return FileScan{Overload: overload}, nil
	}
	var paths []string
	if f.previous != nil {
		for name, value := range current {
			if excludedPath(filepath.Join(f.directory, name), f.previousExcluded) {
				continue
			}
			if previous, exists := f.previous[name]; !exists || previous != value {
				paths = append(paths, name)
			}
		}
		for name := range f.previous {
			if excludedPath(filepath.Join(f.directory, name), f.excluded) {
				continue
			}
			if _, exists := current[name]; !exists {
				paths = append(paths, name)
			}
		}
	}
	slices.Sort(paths)
	f.previous = current
	f.previousExcluded = slices.Clone(f.excluded)
	return FileScan{Paths: paths}, nil
}
