//go:build linux || darwin

package process

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func bashPath() (string, error) { return exec.LookPath("bash") }

func resolveLauncher(executable string, args []string) (string, []string) { return executable, args }

func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
