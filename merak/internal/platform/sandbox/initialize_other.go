//go:build !windows

package sandbox

import (
	"context"
	"errors"
)

func initialize(context.Context, string) error { return errors.New("MRK-5004") }
