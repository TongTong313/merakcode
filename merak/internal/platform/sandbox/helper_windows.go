package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

const windowsHelperArgument = "--merak-sandbox-windows-helper"

type windowsLaunch struct {
	Terminal  bool     `json:"terminal,omitempty"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
	Directory string   `json:"directory"`
	Env       []string `json:"env"`
}

func init() {
	if len(os.Args) != 4 || os.Args[1] != windowsHelperArgument {
		return
	}
	code, err := runWindowsHelper(os.Args[2], os.Args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, "MRK-5004")
		code = 125
	}
	os.Exit(code)
}

func runWindowsHelper(address, secret string) (code int, returned error) {
	endpoint, err := net.ResolveTCPAddr("tcp4", address)
	if err != nil || !endpoint.IP.IsLoopback() || secret == "" {
		return 0, errors.New("invalid sandbox control endpoint")
	}
	connection, err := net.DialTimeout("tcp4", address, 5*time.Second)
	if err != nil {
		return 0, err
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return 0, err
	}
	var original windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_DEFAULT, &original); err != nil {
		return 0, err
	}
	defer original.Close()
	user, err := original.GetTokenUser()
	if err != nil {
		return 0, err
	}
	if err := json.NewEncoder(connection).Encode(map[string]string{"token": secret, "accountSID": user.User.Sid.String()}); err != nil {
		return 0, err
	}
	defer func() {
		result := map[string]any{"exitCode": code}
		if returned != nil {
			result["error"] = returned.Error()
		}
		_ = json.NewEncoder(connection).Encode(result)
	}()
	var launch windowsLaunch
	if err := json.NewDecoder(connection).Decode(&launch); err != nil {
		return 0, err
	}
	token, err := windowsWriteRestrictedToken(original, user.User.Sid)
	if err != nil {
		return 0, err
	}
	defer token.Close()
	cmd := process.Command(context.Background(), launch.Directory, launch.Command, launch.Args...)
	cmd.Env = launch.Env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr.Token = syscall.Token(token)
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return 0, err
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	closeDesktop, err := windowsStartMember(cmd, user.User.Sid, launch.Terminal)
	if err != nil {
		return 0, err
	}
	defer closeDesktop()
	defer windows.TerminateJobObject(job, 125)
	if err := windowsAssignMember(job, uint32(cmd.Process.Pid)); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return 0, err
	}
	if err := json.NewEncoder(connection).Encode(map[string]bool{"ready": true}); err != nil {
		return 0, err
	}
	var accepted bool
	if err := json.NewDecoder(connection).Decode(&accepted); err != nil || !accepted {
		return 0, errors.New("sandbox controller ended before startup")
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return 0, err
	}
	if err := windowsResumeMember(uint32(cmd.Process.Pid)); err != nil {
		return 0, err
	}
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		_, _ = io.Copy(io.Discard, connection)
		_ = windows.TerminateJobObject(job, 125)
	}()
	defer func() { _ = connection.SetReadDeadline(time.Now()); <-monitorDone }()
	if err := cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), nil
		}
		return 0, err
	}
	return 0, nil
}

func windowsAssignMember(job windows.Handle, pid uint32) error {
	child, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(child)
	return windows.AssignProcessToJobObject(job, child)
}

func windowsResumeMember(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	err = windows.Thread32First(snapshot, &entry)
	for err == nil {
		if entry.OwnerProcessID == pid {
			thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if err != nil {
				return err
			}
			defer windows.CloseHandle(thread)
			_, err = windows.ResumeThread(thread)
			return err
		}
		err = windows.Thread32Next(snapshot, &entry)
	}
	return fmt.Errorf("find suspended member thread: %w", err)
}

func windowsWriteRestrictedToken(original windows.Token, account *windows.SID) (windows.Token, error) {
	var token windows.Token
	everyone, err := windows.StringToSid("S-1-1-0")
	if err != nil {
		return 0, err
	}
	writeRestricted, err := windows.StringToSid("S-1-5-33")
	if err != nil {
		return 0, err
	}
	restricting := []windows.SIDAndAttributes{{Sid: account}, {Sid: everyone}, {Sid: writeRestricted}}
	create := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	result, _, err := create.Call(uintptr(original), 8, 0, 0, 0, 0, uintptr(len(restricting)), uintptr(unsafe.Pointer(&restricting[0])), uintptr(unsafe.Pointer(&token)))
	runtime.KeepAlive(restricting)
	if result == 0 {
		return 0, fmt.Errorf("create restricted token: %w", err)
	}
	return token, nil
}
