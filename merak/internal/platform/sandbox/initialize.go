package sandbox

import (
	"context"
	"errors"
	"path/filepath"
)

var initializing = make(chan struct{}, 1)

// Initialize sets up the Windows account pool after the operating system confirms elevation.
func Initialize(ctx context.Context, directory string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if directory == "" || !filepath.IsAbs(directory) || filepath.Dir(filepath.Clean(directory)) == filepath.Clean(directory) {
		return errors.New("MRK-5004")
	}
	select {
	case initializing <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-initializing }()
	return initialize(ctx, directory)
}
