package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"slices"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func windowsPermanentReadDenials(directory string, p Profile) error {
	lock, err := os.OpenFile(filepath.Join(directory, "accounts.lock"), os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := windows.LockFileEx(windows.Handle(lock.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, new(windows.Overlapped)); err != nil {
		return err
	}
	manifest, err := readWindowsAccounts(directory)
	if err != nil {
		return err
	}
	var paths []string
	for _, path := range p.ReadDeny {
		if slices.Contains(p.TransientReadDeny, path) {
			continue
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return err
		}
		paths = append(paths, path)
		if !slices.Contains(manifest.DenyRoots, path) {
			manifest.DenyRoots = append(manifest.DenyRoots, path)
		}
	}
	if len(paths) == 0 {
		return nil
	}
	if err := writeWindowsLeaseJournal(filepath.Join(directory, "accounts.json"), manifest); err != nil {
		return err
	}
	for _, path := range paths {
		cmd := process.Command(context.Background(), "", filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), path, "/deny", "*"+manifest.Group.SID+":(OI)(CI)R")
		if err := cmd.Run(); err != nil {
			return err
		}
	}
	return nil
}
