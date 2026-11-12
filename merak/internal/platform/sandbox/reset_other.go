//go:build !windows

package sandbox

import (
	"context"
	"errors"
)

// reset has nothing to undo on these systems: only Windows makes accounts.
func reset(context.Context, string) error { return errors.New("MRK-5013") }
