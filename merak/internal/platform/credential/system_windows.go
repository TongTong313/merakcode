package credential

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"runtime"
	"unsafe"
)

var vault = windows.NewLazySystemDLL("advapi32.dll")
var writeCredential = vault.NewProc("CredWriteW")
var readCredential = vault.NewProc("CredReadW")
var deleteCredential = vault.NewProc("CredDeleteW")
var freeCredential = vault.NewProc("CredFree")

// nativeCredential follows CREDENTIALW from wincred.h.
type nativeCredential struct {
	Flags, Type             uint32
	Target, Comment         *uint16
	Written                 windows.Filetime
	Size                    uint32
	Blob                    *byte
	Persist, AttributeCount uint32
	Attributes              uintptr
	Alias, User             *uint16
}

func systemSet(ctx context.Context, key string, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(value) > 2560 {
		return errors.New("credential exceeds system vault limit")
	}
	target, err := windows.UTF16PtrFromString(key)
	if err != nil {
		return err
	}
	record := nativeCredential{Type: 1, Target: target, Size: uint32(len(value)), Blob: unsafe.SliceData(value), Persist: 2}
	ok, _, err := writeCredential.Call(uintptr(unsafe.Pointer(&record)), 0)
	runtime.KeepAlive(record)
	runtime.KeepAlive(value)
	if ok == 0 {
		return err
	}
	return nil
}
func systemGet(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	target, err := windows.UTF16PtrFromString(key)
	if err != nil {
		return nil, err
	}
	var record *nativeCredential
	ok, _, err := readCredential.Call(uintptr(unsafe.Pointer(target)), 1, 0, uintptr(unsafe.Pointer(&record)))
	runtime.KeepAlive(target)
	if ok == 0 {
		if errors.Is(err, windows.ERROR_NOT_FOUND) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	defer freeCredential.Call(uintptr(unsafe.Pointer(record)))
	return append([]byte(nil), unsafe.Slice(record.Blob, record.Size)...), nil
}
func systemDelete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(key)
	if err != nil {
		return err
	}
	ok, _, err := deleteCredential.Call(uintptr(unsafe.Pointer(target)), 1, 0)
	runtime.KeepAlive(target)
	if ok == 0 {
		if errors.Is(err, windows.ERROR_NOT_FOUND) {
			return os.ErrNotExist
		}
		return err
	}
	return nil
}
func secureDirectory(path string) error {
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + current.User.Sid.String() + ")")
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	runtime.KeepAlive(descriptor)
	return err
}
