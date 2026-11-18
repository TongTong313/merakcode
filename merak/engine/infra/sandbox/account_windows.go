package sandbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsAccount struct {
	Name       string `json:"name"`
	SID        string `json:"sid"`
	Credential string `json:"credential"`
	Firewall   string `json:"firewall"`
}

type windowsAccounts struct {
	Version  int              `json:"version"`
	Owner    string           `json:"owner"`
	Pool     string           `json:"pool"`
	Ready    bool             `json:"ready"`
	Accounts []windowsAccount `json:"accounts"`
	Group    struct {
		Name string `json:"name"`
		SID  string `json:"sid"`
	} `json:"group"`
	ReadRoots []string `json:"readRoots"`
	DenyRoots []string `json:"denyRoots"`
}

func readWindowsAccounts(directory string) (windowsAccounts, error) {
	var manifest windowsAccounts
	if directory == "" {
		return manifest, errors.New("MRK-5004")
	}
	body, err := os.ReadFile(filepath.Join(directory, "accounts.json"))
	if err != nil {
		return manifest, err
	}
	if err := json.Unmarshal(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}), &manifest); err != nil {
		return manifest, err
	}
	owner, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return manifest, err
	}
	if manifest.Version != 1 || !manifest.Ready || manifest.Owner != owner.User.Sid.String() || len(manifest.Accounts) == 0 {
		return manifest, errors.New("invalid sandbox account pool")
	}
	group, _, _, err := windows.LookupSID("", manifest.Group.Name)
	if err != nil || manifest.Group.Name != "merak-sbx-"+manifest.Pool || group.String() != manifest.Group.SID {
		return manifest, errors.New("sandbox group identity changed")
	}
	for _, account := range manifest.Accounts {
		if !strings.HasPrefix(account.Name, "merak-sbx-"+manifest.Pool+"-") || account.Credential != "MerakCode/Sandbox/"+manifest.Pool+"/"+account.Name {
			return manifest, errors.New("invalid sandbox account")
		}
		sid, _, _, err := windows.LookupSID("", account.Name)
		if err != nil || sid.String() != account.SID {
			return manifest, errors.New("sandbox account identity changed")
		}
	}
	return manifest, nil
}

type windowsCredential struct {
	Flags, Type     uint32
	Target, Comment *uint16
	Written         windows.Filetime
	BlobSize        uint32
	Blob            *byte
	Persist, Count  uint32
	Attributes      uintptr
	Alias, Username *uint16
}

func accountPassword(account windowsAccount) (string, error) {
	target, err := windows.UTF16PtrFromString(account.Credential)
	if err != nil {
		return "", err
	}
	var credential *windowsCredential
	api := windows.NewLazySystemDLL("advapi32.dll")
	ok, _, err := api.NewProc("CredReadW").Call(uintptr(unsafe.Pointer(target)), 1, 0, uintptr(unsafe.Pointer(&credential)))
	runtime.KeepAlive(target)
	if ok == 0 {
		return "", err
	}
	defer api.NewProc("CredFree").Call(uintptr(unsafe.Pointer(credential)))
	if credential.BlobSize == 0 || credential.BlobSize%2 != 0 || credential.BlobSize > 2560 {
		return "", errors.New("invalid sandbox credential")
	}
	return windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(credential.Blob)), credential.BlobSize/2)), nil
}
