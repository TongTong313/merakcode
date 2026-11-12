package sandbox

import (
	"context"
	"errors"
	"path/filepath"
)

func reset(ctx context.Context, directory string) error {
	err := runElevated(ctx, "MRK-5013", []string{"reset-windows.ps1", "credential-windows.ps1", "access-windows.ps1"}, func(temporary string) string {
		return "& " + powershellLiteral(filepath.Join(temporary, "reset-windows.ps1")) + " -StateDir " + powershellLiteral(directory)
	})
	if err != nil {
		return err
	}
	if Initialized(directory) {
		return errors.New("MRK-5013")
	}
	return nil
}
