package sandbox

import (
	"os"
	"path/filepath"
)

// PrepareStateDirectory creates missing product state directories for the user.
// Existing directories retain their permissions.
func PrepareStateDirectory(path string) error {
	info, err := os.Stat(path)
	if err == nil {
		if !info.IsDir() {
			return &os.PathError{Op: "mkdir", Path: path, Err: os.ErrExist}
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	if err := PrepareStateDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0700); err != nil {
		if os.IsExist(err) {
			return PrepareStateDirectory(path)
		}
		return err
	}
	return privateStatePath(path, true)
}

// CreateStateFile never replaces an existing configuration or its permissions.
func CreateStateFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	if err := privateStatePath(path, false); err != nil {
		file.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return file, nil
}
