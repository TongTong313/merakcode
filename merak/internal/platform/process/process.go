// Package process starts command processes and stops their descendants on cancellation.
package process

import (
	"context"
	"os/exec"
	"time"
)

type reflogActionKey struct{}

// WithReflogAction attributes Git reference updates made by descendant processes.
func WithReflogAction(ctx context.Context, action string) context.Context {
	return context.WithValue(ctx, reflogActionKey{}, action)
}

func Shell(ctx context.Context, workdir, command string) (*exec.Cmd, error) {
	path, err := bashPath()
	if err != nil {
		return nil, err
	}
	return Command(ctx, workdir, path, "--noprofile", "--norc", "-c", command), nil
}

// Command starts a hidden process and stops descendants when its context ends.
func Command(ctx context.Context, workdir, executable string, args ...string) *exec.Cmd {
	executable, args = resolveLauncher(executable, args)
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = workdir
	if action, _ := ctx.Value(reflogActionKey{}).(string); action != "" {
		cmd.Env = append(cmd.Environ(), "GIT_REFLOG_ACTION="+action)
	}
	cmd.WaitDelay = time.Second
	configure(cmd)
	return cmd
}
