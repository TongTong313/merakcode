//go:build !windows

package credential

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

func secureDirectory(path string) error { return os.Chmod(path, 0700) }
func systemSet(ctx context.Context, key string, value []byte) error {
	encoded := base64.StdEncoding.EncodeToString(value)
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.CommandContext(ctx, "/usr/bin/security", "-i")
		command.Stdin = strings.NewReader("add-generic-password -U -a MerakCode -s " + key + " -w " + encoded + "\nquit\n")
	} else {
		command = exec.CommandContext(ctx, "secret-tool", "store", "--label=MerakCode", "service", "MerakCode", "key", key)
		command.Stdin = strings.NewReader(encoded)
	}
	if err := command.Run(); err != nil {
		return err
	}
	// Interactive keychain commands can exit successfully after a command failure.
	read, err := systemGet(ctx, key)
	if err != nil {
		return err
	}
	if !bytes.Equal(read, value) {
		return errors.New("credential verification failed")
	}
	return nil
}
func systemGet(ctx context.Context, key string) ([]byte, error) {
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.CommandContext(ctx, "/usr/bin/security", "find-generic-password", "-w", "-a", "MerakCode", "-s", key)
	} else {
		command = exec.CommandContext(ctx, "secret-tool", "lookup", "service", "MerakCode", "key", key)
	}
	output, err := command.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 1 || exit.ExitCode() == 44) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(string(output)))
}
func systemDelete(ctx context.Context, key string) error {
	var command *exec.Cmd
	if runtime.GOOS == "darwin" {
		command = exec.CommandContext(ctx, "/usr/bin/security", "delete-generic-password", "-a", "MerakCode", "-s", key)
	} else {
		command = exec.CommandContext(ctx, "secret-tool", "clear", "service", "MerakCode", "key", key)
	}
	err := command.Run()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && (exit.ExitCode() == 1 || exit.ExitCode() == 44) {
			return os.ErrNotExist
		}
	}
	return err
}
