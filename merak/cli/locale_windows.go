package cli

import (
	"syscall"
	"unsafe"
)

func systemLocale() string {
	const localeNameMaxLength = 85
	var name [localeNameMaxLength]uint16
	procedure := syscall.NewLazyDLL("kernel32.dll").NewProc("GetUserDefaultLocaleName")
	length, _, _ := procedure.Call(uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)))
	if length == 0 {
		return "en"
	}
	return syscall.UTF16ToString(name[:])
}
