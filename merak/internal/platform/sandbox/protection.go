package sandbox

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

type protectedEntry struct {
	body []byte
	mode os.FileMode
}

func existingProtection(p Profile) (Profile, error) {
	existing := make([]string, 0, len(p.Protect))
	for _, path := range p.Protect {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return p, err
		}
		existing = append(existing, path)
	}
	p.Protect = existing
	return p, nil
}

type protectionSnapshot struct {
	root    *os.Root
	path    string
	entries map[string]protectedEntry
}

type ProtectionError struct {
	Paths []string
	Err   error
}

func (e *ProtectionError) Error() string {
	message := "MRK-5007: protected paths changed: " + strings.Join(e.Paths, ", ")
	if e.Err != nil {
		message += ": " + e.Err.Error()
	}
	return message
}

func (e *ProtectionError) Unwrap() error { return e.Err }

// Start keeps protection snapshots in the controlling process until Wait restores them.
func (l *Launcher) Start(cmd *exec.Cmd, p Profile) error {
	if l == nil || l.Disabled {
		return cmd.Start()
	}
	var snapshots []protectionSnapshot
	started := false
	defer func() {
		if !started {
			for _, snapshot := range snapshots {
				snapshot.root.Close()
			}
		}
	}()
	for _, path := range p.Protect {
		_, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		root, err := os.OpenRoot(filepath.Dir(path))
		if err != nil {
			return err
		}
		snapshot := protectionSnapshot{root: root, path: path}
		snapshot.entries, err = snapshot.capture()
		if err != nil {
			root.Close()
			return err
		}
		snapshots = append(snapshots, snapshot)
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return errors.New("sandbox claim has ended")
	}
	capture := new(denialCapture)
	if _, pipe := cmd.Stderr.(*os.File); !pipe {
		cmd.Stderr = denialOutput{target: cmd.Stderr, capture: capture, stderr: true}
	}
	if _, pipe := cmd.Stdout.(*os.File); cmd.Stdout != nil && !pipe {
		cmd.Stdout = denialOutput{target: cmd.Stdout, capture: capture}
	}
	if err := cmd.Start(); err != nil {
		startup := l.startups[cmd]
		delete(l.startups, cmd)
		if startup != nil && runtime.GOOS == "windows" {
			l.runtimeFailure = true
			err = errors.Join(errors.New("MRK-5004"), err)
		}
		l.mu.Unlock()
		if startup != nil {
			startup.close()
		}
		return err
	}
	started = true
	if l.protections == nil {
		l.protections = make(map[*exec.Cmd][]protectionSnapshot)
	}
	l.protections[cmd] = snapshots
	if l.running == nil {
		l.running = make(map[*exec.Cmd]*launchRun)
	}
	l.running[cmd] = &launchRun{done: make(chan struct{}), denial: capture}
	startup := l.startups[cmd]
	l.mu.Unlock()
	if startup != nil {
		if err := startup.wait(); err != nil {
			if cmd.Cancel != nil {
				_ = cmd.Cancel()
			} else {
				_ = cmd.Process.Kill()
			}
			_ = l.Wait(cmd)
			return err
		}
	}
	return nil
}

// Wait restores protected paths even after cancellation or a nonzero exit.
func (l *Launcher) Wait(cmd *exec.Cmd) error {
	if l == nil || l.Disabled {
		return cmd.Wait()
	}
	l.mu.Lock()
	run := l.running[cmd]
	l.mu.Unlock()
	if run == nil {
		return cmd.Wait()
	}
	run.once.Do(func() {
		run.err = l.waitProtected(cmd)
		close(run.done)
	})
	<-run.done
	return run.err
}

func (l *Launcher) waitProtected(cmd *exec.Cmd) error {
	runErr := cmd.Wait()
	if l == nil || l.Disabled {
		return runErr
	}
	l.mu.Lock()
	capture := l.running[cmd].denial
	snapshots := l.protections[cmd]
	delete(l.protections, cmd)
	startup := l.startups[cmd]
	delete(l.startups, cmd)
	l.mu.Unlock()
	if startup != nil {
		startup.close()
	}
	if failure := capture.failure(); failure != nil {
		if l.FileDenied != nil {
			runErr = errors.Join(runErr, l.FileDenied(failure))
		}
		runErr = errors.Join(runErr, failure)
	}
	defer func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		delete(l.running, cmd)
		if l.active == 0 && len(l.running) == 0 {
			l.idleSince = time.Now()
		}
	}()
	var changed []string
	var restoreErr error
	for _, snapshot := range snapshots {
		paths, err := snapshot.restore()
		snapshot.root.Close()
		changed = append(changed, paths...)
		if err != nil {
			restoreErr = errors.Join(restoreErr, fmt.Errorf("restore %s: %w", snapshot.path, err))
		}
	}
	if len(changed) != 0 {
		slices.Sort(changed)
		changed = slices.Compact(changed)
		failure := &ProtectionError{Paths: changed, Err: restoreErr}
		if l.ProtectionChanged != nil {
			runErr = errors.Join(runErr, l.ProtectionChanged(failure))
		}
		return errors.Join(runErr, failure)
	}
	return runErr
}

func (s protectionSnapshot) capture() (map[string]protectedEntry, error) {
	entries := make(map[string]protectedEntry)
	err := fs.WalkDir(s.root.FS(), filepath.Base(s.path), func(path string, entry fs.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		value := protectedEntry{mode: info.Mode()}
		switch {
		case info.IsDir():
		case info.Mode().IsRegular():
			value.body, err = s.root.ReadFile(path)
		case info.Mode()&os.ModeSymlink != 0:
			var target string
			target, err = s.root.Readlink(path)
			value.body = []byte(target)
		default:
			err = fmt.Errorf("unsupported protected file type: %s", path)
		}
		if err != nil {
			return err
		}
		entries[path] = value
		return nil
	})
	return entries, err
}

func (s protectionSnapshot) restore() ([]string, error) {
	current, readErr := s.capture()
	var changed []string
	for path, before := range s.entries {
		after, exists := current[path]
		if !exists || before.mode != after.mode || !bytes.Equal(before.body, after.body) {
			changed = append(changed, filepath.Join(filepath.Dir(s.path), filepath.FromSlash(path)))
		}
	}
	for path := range current {
		if _, exists := s.entries[path]; !exists {
			changed = append(changed, filepath.Join(filepath.Dir(s.path), filepath.FromSlash(path)))
		}
	}
	if readErr != nil && len(changed) == 0 {
		changed = append(changed, s.path)
	}
	if len(changed) == 0 {
		return nil, nil
	}
	var removals []string
	for path, after := range current {
		before, exists := s.entries[path]
		if !exists || before.mode.Type() != after.mode.Type() || before.mode&os.ModeSymlink != 0 && !bytes.Equal(before.body, after.body) {
			removals = append(removals, path)
		}
	}
	slices.Sort(removals)
	for i := len(removals) - 1; i >= 0; i-- {
		if err := s.root.RemoveAll(removals[i]); err != nil {
			return changed, err
		}
	}
	paths := make([]string, 0, len(s.entries))
	for path := range s.entries {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	for _, path := range paths {
		entry := s.entries[path]
		after, exists := current[path]
		if exists && entry.mode == after.mode && bytes.Equal(entry.body, after.body) {
			continue
		}
		var err error
		switch {
		case entry.mode.IsDir():
			if !exists || !after.mode.IsDir() {
				err = s.root.Mkdir(path, 0700)
			}
		case entry.mode&os.ModeSymlink != 0:
			err = s.root.Symlink(string(entry.body), path)
		default:
			if exists && after.mode.IsRegular() {
				if err := s.root.Chmod(path, entry.mode.Perm()|0200); err != nil {
					return changed, err
				}
			}
			err = s.root.WriteFile(path, entry.body, entry.mode.Perm())
		}
		if err != nil {
			return changed, err
		}
	}
	for i := len(paths) - 1; i >= 0; i-- {
		entry := s.entries[paths[i]]
		if after, exists := current[paths[i]]; exists && entry.mode == after.mode && bytes.Equal(entry.body, after.body) {
			continue
		}
		if entry.mode&os.ModeSymlink == 0 {
			if err := s.root.Chmod(paths[i], entry.mode.Perm()); err != nil {
				return changed, err
			}
		}
	}
	return changed, readErr
}
