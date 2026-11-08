//go:build !windows

package server

import (
	"os"
	"syscall"
)

func secureDirectory(path string) error { return os.Chmod(path, 0700) }
func lockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
