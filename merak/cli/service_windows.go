package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// windowsRunKey is the registry key whose values Windows starts when the current user logs in. Tests point it at a
// key of their own.
var windowsRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

// reg runs reg.exe from the system folder without a window.
func reg(args ...string) error {
	command := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "reg.exe"), args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return command.Run()
}

// installService sets the Run value of the current user. The data root does not apply: a Run value cannot carry
// environment variables.
func installService(executable, _ string) error {
	command, err := windowsRunCommand(executable)
	if err != nil {
		return err
	}
	return reg("add", windowsRunKey, "/v", windowsRunName, "/t", "REG_SZ", "/d", command, "/f")
}

// uninstallService deletes the Run value, if there is one.
func uninstallService() error {
	// query fails when the value does not exist, and then there is nothing to delete
	if reg("query", windowsRunKey, "/v", windowsRunName) != nil {
		return nil
	}
	return reg("delete", windowsRunKey, "/v", windowsRunName, "/f")
}
