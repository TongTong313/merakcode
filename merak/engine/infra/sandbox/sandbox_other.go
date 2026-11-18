//go:build !linux && !windows && !darwin

package sandbox

import (
	"context"
	"errors"
	"os/exec"
)

func (l *Launcher) platformCommand(context.Context, Profile, string, ...string) (*exec.Cmd, error) {
	return nil, errors.New("sandbox is unavailable")
}

func (l *Launcher) platformStatus(context.Context, Profile) Status {
	return Status{Backend: "none", Network: "none", Reason: "MRK-5004"}
}
