package engine_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

const networkFixtureAddress = "1.1.1.1"
const networkFixtureEnvironment = "MERAKCODE_TEST_PUBLIC_NETWORK"

var publicNetworkFixtureReady bool

func init() {
	if os.Getenv(networkFixtureEnvironment) != "1" {
		return
	}
	if err := os.Unsetenv(networkFixtureEnvironment); err != nil {
		panic(err)
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, 0)
	if err != nil {
		panic(err)
	}
	defer syscall.Close(fd)
	flags := struct {
		Name  [16]byte
		Flags uint16
		Pad   [22]byte
	}{}
	copy(flags.Name[:], "lo")
	ioctl := func(request uintptr, value unsafe.Pointer) {
		if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), request, uintptr(value)); errno != 0 {
			panic(errno)
		}
	}
	ioctl(syscall.SIOCGIFFLAGS, unsafe.Pointer(&flags))
	flags.Flags |= syscall.IFF_UP
	ioctl(syscall.SIOCSIFFLAGS, unsafe.Pointer(&flags))
	address := struct {
		Name    [16]byte
		Family  uint16
		Port    uint16
		Address [4]byte
		Pad     [16]byte
	}{Family: syscall.AF_INET, Address: [4]byte{1, 1, 1, 1}}
	copy(address.Name[:], "lo:merak")
	ioctl(syscall.SIOCSIFADDR, unsafe.Pointer(&address))
	address.Address = [4]byte{255, 255, 255, 255}
	ioctl(syscall.SIOCSIFNETMASK, unsafe.Pointer(&address))
	publicNetworkFixtureReady = true
}

// The fixture owns a public address inside an isolated network; no traffic leaves it.
func runInPublicNetwork(t *testing.T) bool {
	t.Helper()
	if publicNetworkFixtureReady {
		return false
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	cmd := process.Command(ctx, "", os.Args[0], "-test.v", "-test.run=^"+regexp.QuoteMeta(t.Name())+"$", "-test.timeout=25s")
	cmd.Env = append(os.Environ(), networkFixtureEnvironment+"=1")
	cmd.SysProcAttr.Cloneflags = syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET
	cmd.SysProcAttr.UidMappings = []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}}
	cmd.SysProcAttr.GidMappings = []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}}
	cmd.SysProcAttr.GidMappingsEnableSetgroups = false
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated public network: %v\n%s", err, output)
	}
	return true
}

func publicNetworkServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	listener, err := net.Listen("tcp", net.JoinHostPort(networkFixtureAddress, "0"))
	if err != nil {
		t.Fatal(fmt.Errorf("listen on the isolated public address: %w", err))
	}
	server := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}
	server.Start()
	t.Cleanup(server.Close)
	return server
}
