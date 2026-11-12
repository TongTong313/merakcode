package sandbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
)

// Initialized tells whether the state folder holds an account pool that Initialize made.
func Initialized(directory string) bool {
	if directory == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(directory, "accounts.json"))
	return err == nil && info.Mode().IsRegular()
}

// Reset undoes Initialize after the operating system confirms elevation: it deletes the sandbox accounts, their
// profiles, credentials and firewall rules, takes back the folder permissions they were given and removes the state
// folder. A folder without a pool is left as it is.
func Reset(ctx context.Context, directory string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if directory == "" || !filepath.IsAbs(directory) || filepath.Dir(filepath.Clean(directory)) == filepath.Clean(directory) {
		return errors.New("MRK-5013")
	}
	if !Initialized(directory) {
		return nil
	}
	select {
	case initializing <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-initializing }()
	return reset(ctx, directory)
}
