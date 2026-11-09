package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Members use account-owned window objects so USER32 can initialize without host desktop permissions.
func windowsStartMember(cmd *exec.Cmd, account *windows.SID, terminal bool) (func(), error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	api := windows.NewLazySystemDLL("user32.dll")
	station, _, err := api.NewProc("GetProcessWindowStation").Call()
	if station == 0 {
		return nil, err
	}
	desktop, _, err := api.NewProc("GetThreadDesktop").Call(uintptr(windows.GetCurrentThreadId()))
	if desktop == 0 {
		return nil, err
	}
	security, err := windows.SecurityDescriptorFromString("D:(A;;GA;;;SY)(A;;GA;;;" + account.String() + ")")
	if err != nil {
		return nil, err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: security, InheritHandle: 1}
	private, _, err := api.NewProc("CreateWindowStationW").Call(0, 0, 0xf037f, uintptr(unsafe.Pointer(&attributes)))
	if private == 0 {
		return nil, fmt.Errorf("create sandbox window station: %w", err)
	}
	closeStation := func() { api.NewProc("CloseWindowStation").Call(private) }
	if ok, _, err := api.NewProc("SetProcessWindowStation").Call(private); ok == 0 {
		closeStation()
		return nil, err
	}
	defer api.NewProc("SetProcessWindowStation").Call(station)
	name, _ := windows.UTF16PtrFromString("default")
	privateDesktop, _, err := api.NewProc("CreateDesktopW").Call(uintptr(unsafe.Pointer(name)), 0, 0, 0, 0xf01ff, uintptr(unsafe.Pointer(&attributes)))
	runtime.KeepAlive(security)
	if privateDesktop == 0 {
		closeStation()
		return nil, fmt.Errorf("create sandbox desktop: %w", err)
	}
	cleanup := func() {
		api.NewProc("CloseDesktop").Call(privateDesktop)
		closeStation()
	}
	if ok, _, err := api.NewProc("SetThreadDesktop").Call(privateDesktop); ok == 0 {
		cleanup()
		return nil, err
	}
	var needed uint32
	api.NewProc("GetUserObjectInformationW").Call(private, 2, 0, 0, uintptr(unsafe.Pointer(&needed)))
	stationName := make([]uint16, needed/2)
	if ok, _, err := api.NewProc("GetUserObjectInformationW").Call(private, 2, uintptr(unsafe.Pointer(&stationName[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed))); ok == 0 {
		cleanup()
		return nil, err
	}
	var console windows.Handle
	closeConsole := func() {}
	if terminal {
		console, closeConsole, err = windowsMemberConsole()
		if err != nil {
			cleanup()
			return nil, err
		}
	}
	err = windowsStartOnDesktop(cmd, windows.UTF16ToString(stationName)+"\\default", console)
	api.NewProc("SetProcessWindowStation").Call(station)
	api.NewProc("SetThreadDesktop").Call(desktop)
	if err != nil {
		closeConsole()
		cleanup()
		return nil, err
	}
	return func() { closeConsole(); cleanup() }, nil
}

func windowsStartOnDesktop(cmd *exec.Cmd, desktop string, console windows.Handle) error {
	application, err := windows.UTF16PtrFromString(cmd.Path)
	if err != nil {
		return err
	}
	args := make([]string, len(cmd.Args))
	for i, arg := range cmd.Args {
		args[i] = syscall.EscapeArg(arg)
	}
	command, err := windows.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		return err
	}
	directory, err := windows.UTF16PtrFromString(cmd.Dir)
	if err != nil {
		return err
	}
	name, err := windows.UTF16PtrFromString(desktop)
	if err != nil {
		return err
	}
	env := append([]string(nil), cmd.Env...)
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	block := utf16.Encode([]rune(strings.Join(env, "\x00") + "\x00\x00"))
	startup := windows.StartupInfoEx{StartupInfo: windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Desktop: name, Flags: windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW, ShowWindow: windows.SW_HIDE}}
	flags := cmd.SysProcAttr.CreationFlags | windows.CREATE_UNICODE_ENVIRONMENT
	if console != 0 {
		attributes, err := windows.NewProcThreadAttributeList(1)
		if err != nil {
			return err
		}
		defer attributes.Delete()
		if err := attributes.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&console)), unsafe.Sizeof(console)); err != nil {
			return err
		}
		startup.ProcThreadAttributeList = attributes.List()
		startup.Cb = uint32(unsafe.Sizeof(startup))
		flags |= windows.EXTENDED_STARTUPINFO_PRESENT
	}
	current := windows.CurrentProcess()
	for _, pair := range []struct {
		source *os.File
		target *windows.Handle
	}{{os.Stdin, &startup.StdInput}, {os.Stdout, &startup.StdOutput}, {os.Stderr, &startup.StdErr}} {
		if console != 0 {
			break
		}
		if err := windows.DuplicateHandle(current, windows.Handle(pair.source.Fd()), current, pair.target, 0, true, windows.DUPLICATE_SAME_ACCESS); err != nil {
			return err
		}
		defer windows.CloseHandle(*pair.target)
	}
	var info windows.ProcessInformation
	if err := windows.CreateProcessAsUser(windows.Token(cmd.SysProcAttr.Token), application, command, nil, nil, console == 0, flags, &block[0], directory, &startup.StartupInfo, &info); err != nil {
		return err
	}
	defer windows.CloseHandle(info.Thread)
	defer windows.CloseHandle(info.Process)
	cmd.Process, err = os.FindProcess(int(info.ProcessId))
	if err != nil {
		windows.TerminateProcess(info.Process, 125)
	}
	return err
}
