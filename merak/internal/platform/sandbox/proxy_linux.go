package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

const proxyBrokerArgument = "--merak-sandbox-proxy"
const proxyChildArgument = "--merak-sandbox-proxy-child"

func (l *Launcher) linuxProxyCommand(ctx context.Context, profile Profile, executable, body, target string, args ...string) (*exec.Cmd, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	childControl := os.NewFile(uintptr(pair[1]), "sandbox-proxy-child")
	control, err := linuxUnixConnection(os.NewFile(uintptr(pair[0]), "sandbox-proxy-control"))
	if err != nil {
		_ = childControl.Close()
		return nil, err
	}
	proxy := &Proxy{Network: profile.Network, Approve: l.ApproveNetwork, Denied: l.NetworkDenied, MemberName: l.MemberName}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 5 * time.Second}
	context.AfterFunc(ctx, func() {
		_ = childControl.Close()
		_ = server.Close()
		_ = control.Close()
		proxy.Close()
	})
	go func() {
		_ = server.Serve(&linuxTransferredListener{control: control})
	}()
	namespace := networkNamespaces(ctx)
	mode := "ports"
	if namespace {
		mode = "namespace"
	}
	command := process.Command(ctx, "", executable, append([]string{proxyChildArgument, body, mode, target}, args...)...)
	command.ExtraFiles = []*os.File{childControl}
	command.Env = profile.Environment(os.Environ())
	if namespace {
		configureNetworkNamespace(command)
	}
	return command, nil
}

func finishLinuxHelper(code int, err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "MRK-5001")
		os.Exit(125)
	}
	os.Exit(code)
}

func runLinuxBroker(args []string) (int, error) {
	if len(args) < 2 {
		return 0, errors.New("missing proxy broker arguments")
	}
	var profile Profile
	if err := json.Unmarshal([]byte(args[0]), &profile); err != nil {
		return 0, err
	}
	if err := profile.Validate(); err != nil {
		return 0, err
	}
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	childControl := os.NewFile(uintptr(pair[1]), "sandbox-proxy-child")
	defer childControl.Close()
	control, err := linuxUnixConnection(os.NewFile(uintptr(pair[0]), "sandbox-proxy-control"))
	if err != nil {
		return 0, err
	}
	listener := &linuxTransferredListener{control: control}
	proxy := &Proxy{Network: profile.Network}
	defer proxy.Close()
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	serving := make(chan struct{})
	go func() {
		defer close(serving)
		_ = server.Serve(listener)
	}()
	defer func() { _ = server.Close(); <-serving }()
	namespace := networkNamespaces(context.Background())
	mode := "ports"
	if namespace {
		mode = "namespace"
	}
	child := exec.Command(os.Args[0], append([]string{proxyChildArgument, args[0], mode}, args[1:]...)...)
	child.ExtraFiles = []*os.File{childControl}
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	if namespace {
		child.SysProcAttr = new(syscall.SysProcAttr)
		configureNetworkNamespace(child)
	}
	return linuxChildResult(child.Run())
}

func runLinuxProxyChild(args []string) (int, error) {
	if len(args) < 3 {
		return 0, errors.New("missing proxy child arguments")
	}
	var profile Profile
	if err := json.Unmarshal([]byte(args[0]), &profile); err != nil {
		return 0, err
	}
	if err := profile.Validate(); err != nil {
		return 0, err
	}
	if args[1] == "namespace" {
		if err := enableLinuxLoopback(); err != nil {
			return 0, err
		}
	}
	control, err := linuxUnixConnection(os.NewFile(3, "sandbox-proxy-control"))
	if err != nil {
		return 0, err
	}
	defer control.Close()
	listener, closeRelay, err := startLinuxTransfer(control)
	if err != nil {
		return 0, err
	}
	defer closeRelay()
	port := listener.Addr().(*net.TCPAddr).Port
	child := exec.Command(args[2], args[3:]...)
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	child.Env = proxyEnvironment(profile.Environment(os.Environ()), "http://"+listener.Addr().String())
	// The relay keeps its own threads; only the target inherits this thread's rules.
	runtime.LockOSThread()
	if err := restrictLinuxFiles(profile, port); err != nil {
		return 0, err
	}
	return linuxChildResult(child.Run())
}

func linuxChildResult(err error) (int, error) {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	return 0, err
}

func proxyEnvironment(source []string, address string) []string {
	result := make([]string, 0, len(source)+6)
	for _, value := range source {
		name, _, _ := strings.Cut(value, "=")
		switch strings.ToUpper(name) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
			continue
		}
		result = append(result, value)
	}
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		result = append(result, name+"="+address)
	}
	return result
}

func enableLinuxLoopback() error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	request, err := unix.NewIfreq("lo")
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, request); err != nil {
		return err
	}
	request.SetUint16(request.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, request)
}

func linuxUnixConnection(file *os.File) (*net.UnixConn, error) {
	defer file.Close()
	connection, err := net.FileConn(file)
	if err != nil {
		return nil, err
	}
	return connection.(*net.UnixConn), nil
}

type linuxTransferredListener struct {
	control *net.UnixConn
}

func (l *linuxTransferredListener) Close() error   { return l.control.Close() }
func (l *linuxTransferredListener) Addr() net.Addr { return l.control.LocalAddr() }

func (l *linuxTransferredListener) Accept() (net.Conn, error) {
	body := make([]byte, 1)
	ancillary := make([]byte, unix.CmsgSpace(4))
	_, size, flags, _, err := l.control.ReadMsgUnix(body, ancillary)
	if err != nil {
		return nil, err
	}
	messages, err := unix.ParseSocketControlMessage(ancillary[:size])
	if err != nil {
		return nil, err
	}
	var descriptors []int
	for _, message := range messages {
		fds, err := unix.ParseUnixRights(&message)
		if err != nil {
			for _, fd := range descriptors {
				_ = unix.Close(fd)
			}
			return nil, err
		}
		descriptors = append(descriptors, fds...)
	}
	if flags&unix.MSG_CTRUNC != 0 || len(descriptors) != 1 {
		for _, fd := range descriptors {
			_ = unix.Close(fd)
		}
		return nil, errors.New("invalid sandbox proxy connection")
	}
	unix.CloseOnExec(descriptors[0])
	file := os.NewFile(uintptr(descriptors[0]), "sandbox-proxy-request")
	defer file.Close()
	return net.FileConn(file)
}

func startLinuxTransfer(control *net.UnixConn) (net.Listener, func(), error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			file, err := client.(*net.TCPConn).File()
			if err == nil {
				_, _, err = control.WriteMsgUnix([]byte{1}, unix.UnixRights(int(file.Fd())), nil)
				_ = file.Close()
			}
			_ = client.Close()
			if err != nil {
				return
			}
		}
	}()
	return listener, func() {
		_ = listener.Close()
		_ = control.Close()
		<-done
	}, nil
}
