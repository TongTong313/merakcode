package pty

import (
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func start(options Options) (_ *Process, returned error) {
	executable, err := exec.LookPath(options.Command)
	if err != nil {
		return nil, err
	}
	inputRead, inputWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer inputRead.Close()
	defer func() {
		if returned != nil {
			inputWrite.Close()
		}
	}()
	outputRead, outputWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer outputWrite.Close()
	defer func() {
		if returned != nil {
			outputRead.Close()
		}
	}()
	var console windows.Handle
	if err = windows.CreatePseudoConsole(windows.Coord{X: int16(options.Cols), Y: int16(options.Rows)}, windows.Handle(inputRead.Fd()), windows.Handle(outputWrite.Fd()), 0, &console); err != nil {
		return nil, err
	}
	defer func() {
		if returned != nil {
			outputRead.Close()
			windows.ClosePseudoConsole(console)
		}
	}()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attributes.Delete()
	if err = attributes.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&console)), unsafe.Sizeof(console)); err != nil {
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		if returned != nil {
			windows.CloseHandle(job)
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	args := []string{syscall.EscapeArg(executable)}
	for _, arg := range options.Args {
		args = append(args, syscall.EscapeArg(arg))
	}
	command, err := windows.UTF16PtrFromString(strings.Join(args, " "))
	if err != nil {
		return nil, err
	}
	var directory *uint16
	if options.Directory != "" {
		directory, err = windows.UTF16PtrFromString(options.Directory)
		if err != nil {
			return nil, err
		}
	}
	env := options.Env
	if env == nil {
		env = os.Environ()
	}
	env = append([]string{}, env...)
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	block := utf16.Encode([]rune(strings.Join(env, "\x00") + "\x00\x00"))
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	// Explicit null standard handles prevent inheriting redirected host pipes.
	// https://github.com/microsoft/terminal/discussions/15814
	startup.Flags = windows.STARTF_USESHOWWINDOW | windows.STARTF_USESTDHANDLES
	startup.ShowWindow = windows.SW_HIDE
	var info windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err = windows.CreateProcess(nil, command, nil, nil, false, flags, &block[0], directory, &startup.StartupInfo, &info); err != nil {
		return nil, err
	}
	defer windows.CloseHandle(info.Thread)
	if err = windows.AssignProcessToJobObject(job, info.Process); err != nil {
		windows.TerminateProcess(info.Process, 1)
		windows.CloseHandle(info.Process)
		return nil, err
	}
	if _, err = windows.ResumeThread(info.Thread); err != nil {
		windows.TerminateProcess(info.Process, 1)
		windows.CloseHandle(info.Process)
		return nil, err
	}
	p := &Process{input: inputWrite, output: outputRead, pid: int(info.ProcessId), done: make(chan struct{}), closing: make(chan struct{})}
	p.resize = func(cols, rows int) error {
		return windows.ResizePseudoConsole(console, windows.Coord{X: int16(cols), Y: int16(rows)})
	}
	p.stop = func() {
		// Terminate clients before closing ConPTY, including clients still initializing.
		_ = windows.TerminateJobObject(job, 1)
		<-p.done
		_ = inputWrite.Close()
		_ = outputRead.Close()
		windows.ClosePseudoConsole(console)
		_ = windows.CloseHandle(job)
	}
	go func() {
		_, _ = windows.WaitForSingleObject(info.Process, windows.INFINITE)
		var code uint32
		_ = windows.GetExitCodeProcess(info.Process, &code)
		p.code = int(code)
		_ = windows.CloseHandle(info.Process)
		close(p.done)
	}()
	return p, nil
}
