package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func init() {
	if len(os.Args) != 3 || os.Args[1] != "--merak-sandbox-windows-broker" {
		return
	}
	code, err := runWindowsBroker(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, "MRK-5004")
		code = 125
	}
	os.Exit(code)
}

func runWindowsBroker(encoded string) (code int, returned error) {
	body, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return 0, err
	}
	var request windowsBrokerRequest
	if err = json.Unmarshal(body, &request); err != nil {
		return 0, err
	}
	endpoint, err := net.ResolveTCPAddr("tcp4", request.StartupAddress)
	if err != nil || !endpoint.IP.IsLoopback() || request.StartupToken == "" {
		return 0, errors.New("invalid sandbox startup endpoint")
	}
	startup, err := net.DialTimeout("tcp4", request.StartupAddress, 5*time.Second)
	if err != nil {
		return 0, err
	}
	defer startup.Close()
	ready := false
	defer func() {
		if ready {
			return
		}
		if err := json.NewEncoder(startup).Encode(windowsStartupMessage{Token: request.StartupToken}); err != nil {
			return
		}
		var approved bool
		if err := json.NewDecoder(startup).Decode(&approved); err != nil || !approved {
			return
		}
		cmd := process.Command(context.Background(), "", request.Command, request.Args...)
		cmd.Env = request.Profile.Environment(os.Environ())
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		returned = cmd.Run()
		var exit *exec.ExitError
		if errors.As(returned, &exit) {
			code, returned = exit.ExitCode(), nil
		}
	}()
	if err = request.Profile.Validate(); err != nil {
		return 0, err
	}
	manifest, err := readWindowsAccounts(request.StateDir)
	if err != nil {
		return 0, err
	}
	index := slices.IndexFunc(manifest.Accounts, func(account windowsAccount) bool { return account.SID == request.AccountSID })
	if index < 0 {
		return 0, errors.New("sandbox account is not in this pool")
	}
	account := manifest.Accounts[index]
	password, err := accountPassword(account)
	if err != nil {
		return 0, err
	}
	private, err := os.MkdirTemp(request.StateDir, "member-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(private)
	if err := windowsPrivateDirectory(private, manifest.Owner, account.SID); err != nil {
		return 0, err
	}
	self, err := os.Executable()
	if err != nil {
		return 0, err
	}
	helper := self
	if strings.EqualFold(request.Command, self) {
		request.Command = helper
	}
	if err := windowsPermanentReadDenials(request.StateDir, request.Profile); err != nil {
		return 0, err
	}
	directory, err := os.Getwd()
	if err != nil {
		return 0, err
	}
	launch := windowsLaunch{Command: request.Command, Args: request.Args, Directory: directory, Env: os.Environ()}
	terminal, restoreConsole := windowsConsoleInput()
	defer restoreConsole()
	launch.Terminal = terminal
	values := make(map[string]string, len(launch.Env)+5)
	for _, entry := range launch.Env {
		name, value, _ := strings.Cut(entry, "=")
		values[strings.ToUpper(name)] = value
	}
	for _, entry := range privateEnvironment(private) {
		name, value, _ := strings.Cut(entry, "=")
		values[strings.ToUpper(name)] = value
	}
	count := 0
	if value := values["GIT_CONFIG_COUNT"]; value != "" {
		count, err = strconv.Atoi(value)
		if err != nil || count < 0 || count > 10000 {
			return 0, errors.New("invalid Git configuration count")
		}
	}
	values["GIT_CONFIG_COUNT"] = strconv.Itoa(count + 1)
	values["GIT_CONFIG_KEY_"+strconv.Itoa(count)] = "safe.directory"
	values["GIT_CONFIG_VALUE_"+strconv.Itoa(count)] = "*"
	launch.Env = make([]string, 0, len(values))
	for name, value := range values {
		launch.Env = append(launch.Env, name+"="+value)
	}
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	if err = listener.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return 0, err
	}
	secret := rand.Text()
	streams, err := newWindowsStreams()
	if err != nil {
		return 0, err
	}
	defer streams.close()
	info, err := windowsLogonHelper(account.Name, password, helper, []string{windowsHelperArgument, listener.Addr().String(), secret}, os.Getenv("SystemRoot"), nil, streams.child)
	if err != nil {
		return 0, fmt.Errorf("start sandbox helper: %w", err)
	}
	password = ""
	defer windows.CloseHandle(info.Process)
	defer windows.CloseHandle(info.Thread)
	defer windows.TerminateProcess(info.Process, 125)
	connection, err := listener.Accept()
	if err != nil {
		return 0, err
	}
	defer connection.Close()
	if err = connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return 0, err
	}
	var identity struct{ Token, AccountSID string }
	decoder := json.NewDecoder(connection)
	if err = decoder.Decode(&identity); err != nil {
		return 0, err
	}
	if identity.Token != secret || identity.AccountSID != account.SID {
		return 0, errors.New("sandbox helper identity mismatch")
	}
	if err = json.NewEncoder(connection).Encode(launch); err != nil {
		return 0, err
	}
	var started struct {
		Ready bool
		Error string
	}
	if err = decoder.Decode(&started); err != nil {
		return 0, err
	}
	if !started.Ready {
		return 0, errors.New("MRK-5004")
	}
	if err = json.NewEncoder(startup).Encode(windowsStartupMessage{Token: request.StartupToken, Ready: true, PrivateDirectory: private}); err != nil {
		return 0, err
	}
	var accepted bool
	if err = json.NewDecoder(startup).Decode(&accepted); err != nil || !accepted {
		return 0, errors.New("sandbox controller ended before startup")
	}
	if err = json.NewEncoder(connection).Encode(true); err != nil {
		return 0, err
	}
	ready = true
	streams.forward()
	startup.Close()
	if err = connection.SetDeadline(time.Time{}); err != nil {
		return 0, err
	}
	var result struct {
		ExitCode int
		Error    string
	}
	if err = decoder.Decode(&result); err != nil {
		return 0, err
	}
	if _, err = windows.WaitForSingleObject(info.Process, windows.INFINITE); err != nil {
		return 0, err
	}
	streams.out.Wait()
	if result.Error != "" {
		return 0, errors.New(result.Error)
	}
	return result.ExitCode, nil
}

func windowsLogonHelper(account, password, executable string, args []string, directory string, env []string, streams [3]*os.File) (windows.ProcessInformation, error) {
	var info windows.ProcessInformation
	username, err := windows.UTF16PtrFromString(account)
	if err != nil {
		return info, err
	}
	domain, _ := windows.UTF16PtrFromString(".")
	credential, err := windows.UTF16FromString(password)
	if err != nil {
		return info, err
	}
	defer clear(credential)
	application, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return info, err
	}
	arguments := []string{syscall.EscapeArg(executable)}
	for _, arg := range args {
		arguments = append(arguments, syscall.EscapeArg(arg))
	}
	command, err := windows.UTF16PtrFromString(strings.Join(arguments, " "))
	if err != nil {
		return info, err
	}
	workdir, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return info, err
	}
	env = append([]string(nil), env...)
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	block := utf16.Encode([]rune(strings.Join(env, "\x00") + "\x00\x00"))
	var environment uintptr
	if env != nil {
		environment = uintptr(unsafe.Pointer(&block[0]))
	}
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Flags: windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW, ShowWindow: windows.SW_HIDE, StdInput: windows.Handle(streams[0].Fd()), StdOutput: windows.Handle(streams[1].Fd()), StdErr: windows.Handle(streams[2].Fd())}
	for _, handle := range []windows.Handle{startup.StdInput, startup.StdOutput, startup.StdErr} {
		if err := windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
			return info, err
		}
	}
	create := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateProcessWithLogonW")
	ok, _, err := create.Call(uintptr(unsafe.Pointer(username)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&credential[0])), 1, uintptr(unsafe.Pointer(application)), uintptr(unsafe.Pointer(command)), windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW, environment, uintptr(unsafe.Pointer(workdir)), uintptr(unsafe.Pointer(&startup)), uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		return info, err
	}
	return info, nil
}
