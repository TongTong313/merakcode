//go:build !darwin && !linux && !windows

package cli

func installService(string, string) error { return errServiceUnsupported }

func uninstallService() error { return errServiceUnsupported }
