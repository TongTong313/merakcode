//go:build windows

package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var getFinalPathNameByHandle = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

// extendedPrefix and extendedUNC start the extended-length form that GetFinalPathNameByHandle answers with.
const (
	extendedPrefix = `\\?\`
	extendedUNC    = `\\?\UNC\`
)

// resolveJunctions follows the junctions of a path. Since Go 1.23 filepath.EvalSymlinks leaves them alone, and a
// junction and its target must be one workspace. Only the part that is a junction is replaced: a drive made by
// subst or a mapped drive keeps the spelling the person gave.
func resolveJunctions(path string) string {
	for range 16 {
		junction, rest := deepestJunction(path)
		if junction == "" {
			return path
		}
		target, ok := finalPath(junction)
		if !ok || strings.EqualFold(target, junction) {
			return path
		}
		path = filepath.Join(target, rest)
	}
	return path
}

// deepestJunction finds the longest part of a path that is a junction and what follows it.
func deepestJunction(path string) (junction, rest string) {
	for current := path; ; {
		if info, err := os.Lstat(current); err == nil && info.Mode()&os.ModeIrregular != 0 {
			remainder, err := filepath.Rel(current, path)
			if err != nil || remainder == "." {
				remainder = ""
			}
			return current, remainder
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", ""
		}
		current = parent
	}
}

// finalPath asks Windows where a directory really is.
func finalPath(path string) (string, bool) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", false
	}
	handle, err := syscall.CreateFile(name, 0,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", false
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]uint16, 512)
	for {
		size, _, _ := getFinalPathNameByHandle.Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
		if size == 0 {
			return "", false
		}
		if int(size) > len(buffer) {
			buffer = make([]uint16, size)
			continue
		}
		return plainPath(syscall.UTF16ToString(buffer[:size])), true
	}
}

// plainPath drops the extended-length prefix of a path.
func plainPath(path string) string {
	if rest, ok := strings.CutPrefix(path, extendedUNC); ok {
		return `\\` + rest
	}
	return strings.TrimPrefix(path, extendedPrefix)
}
