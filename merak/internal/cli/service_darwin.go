//go:build darwin

package cli

import "os"

func installService(executable, root string) error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return installLaunchAgent(userHome, executable, root)
}

func uninstallService() error {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return uninstallLaunchAgent(userHome)
}
