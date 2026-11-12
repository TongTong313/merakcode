//go:build linux

package cli

import (
	"os"
	"os/exec"
)

// systemctl runs systemctl for the current user's systemd instance; tests replace it to record the calls.
var systemctl = func(args ...string) error {
	return exec.Command("systemctl", append([]string{"--user"}, args...)...).Run()
}

// installService writes the user unit and enables it, which makes systemd start it at the user's next login. It does
// not start the engine now.
func installService(executable, root string) error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errServiceUnsupported
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	configHome := systemdConfigHome(userHome)
	if err := writeSystemdUnit(configHome, executable, root); err != nil {
		return err
	}
	if err := systemctl("daemon-reload"); err != nil {
		return err
	}
	return systemctl("enable", systemdUnitName)
}

// uninstallService disables and removes the unit. A running engine keeps running.
func uninstallService() error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errServiceUnsupported
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	// disable fails when the unit was never enabled, which is the state uninstall wants anyway
	_ = systemctl("disable", systemdUnitName)
	if err := removeSystemdUnit(systemdConfigHome(userHome)); err != nil {
		return err
	}
	return systemctl("daemon-reload")
}
