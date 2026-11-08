package server

import (
	"errors"
	"os"
	"os/user"
	"syscall"
	"unsafe"
)

var (
	advapi          = syscall.NewLazyDLL("advapi32.dll")
	kernel          = syscall.NewLazyDLL("kernel32.dll")
	convertSecurity = advapi.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	getDACL         = advapi.NewProc("GetSecurityDescriptorDacl")
	setSecurity     = advapi.NewProc("SetNamedSecurityInfoW")
	localFree       = kernel.NewProc("LocalFree")
	lockFileEx      = kernel.NewProc("LockFileEx")
)

func secureDirectory(path string) error {
	current, err := user.Current()
	if err != nil {
		return err
	}
	sddl, err := syscall.UTF16PtrFromString("D:P(A;OICI;FA;;;" + current.Uid + ")")
	if err != nil {
		return err
	}
	var descriptor uintptr
	ok, _, callErr := convertSecurity.Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if ok == 0 {
		return callErr
	}
	defer localFree.Call(descriptor)
	var present, defaulted int32
	var dacl uintptr
	ok, _, callErr = getDACL.Call(descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 {
		return callErr
	}
	if present == 0 || dacl == 0 {
		return errors.New("MRK-1001")
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	status, _, _ := setSecurity.Call(uintptr(unsafe.Pointer(name)), 1, 0x80000004, 0, 0, dacl, 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	return nil
}

func lockFile(file *os.File) error {
	var overlapped syscall.Overlapped
	ok, _, err := lockFileEx.Call(file.Fd(), 3, 0, 1, 0, uintptr(unsafe.Pointer(&overlapped)))
	if ok == 0 {
		return err
	}
	return nil
}
