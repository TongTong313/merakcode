package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func windowsUnreadableAncestors(account, password string, paths []string) ([]string, error) {
	username, err := windows.UTF16PtrFromString(account)
	if err != nil {
		return nil, err
	}
	domain, _ := windows.UTF16PtrFromString(".")
	credential, err := windows.UTF16FromString(password)
	if err != nil {
		return nil, err
	}
	defer clear(credential)
	var token windows.Token
	api := windows.NewLazySystemDLL("advapi32.dll")
	ok, _, err := api.NewProc("LogonUserW").Call(uintptr(unsafe.Pointer(username)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&credential[0])), 2, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return nil, err
	}
	defer token.Close()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ok, _, err = api.NewProc("ImpersonateLoggedOnUser").Call(uintptr(token))
	if ok == 0 {
		return nil, err
	}
	defer func() {
		if windows.RevertToSelf() != nil {
			os.Exit(125)
		}
	}()
	seen := map[string]bool{}
	var unreadable []string
	for _, path := range paths {
		for ancestor := filepath.Dir(path); ; ancestor = filepath.Dir(ancestor) {
			key := strings.ToUpper(ancestor)
			if seen[key] {
				break
			}
			seen[key] = true
			name, err := windows.UTF16PtrFromString(ancestor)
			if err != nil {
				return nil, err
			}
			handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_EXECUTE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
			if err == nil {
				windows.CloseHandle(handle)
			} else if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
				unreadable = append(unreadable, ancestor)
			} else {
				return nil, err
			}
			if filepath.Dir(ancestor) == ancestor {
				break
			}
		}
	}
	return unreadable, nil
}

// SetFileSecurity changes this directory only; propagating an ancestor ACL would touch unrelated files.
func windowsDirectoryAccess(path, account string, grant bool) error {
	sid, err := windows.StringToSid(account)
	if err != nil {
		return err
	}
	var pin runtime.Pinner
	pin.Pin(sid)
	defer pin.Unpin()
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	mode := windows.REVOKE_ACCESS
	if grant {
		mode = windows.GRANT_ACCESS
	}
	updated, err := windows.BuildSecurityDescriptor(nil, nil, []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.FILE_GENERIC_READ | windows.FILE_GENERIC_EXECUTE,
		AccessMode:        windows.ACCESS_MODE(mode),
		Trustee:           windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_USER, TrusteeValue: windows.TrusteeValueFromSID(sid)},
	}}, nil, descriptor)
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	ok, _, err := windows.NewLazySystemDLL("advapi32.dll").NewProc("SetFileSecurityW").Call(uintptr(unsafe.Pointer(name)), windows.DACL_SECURITY_INFORMATION, uintptr(unsafe.Pointer(updated)))
	runtime.KeepAlive(updated)
	if ok == 0 {
		return err
	}
	return nil
}

func windowsPrivateDirectory(path, owner, account string) error {
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;" + account + ")")
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
