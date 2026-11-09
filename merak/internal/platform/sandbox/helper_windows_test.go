package sandbox_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func TestWindowsSandboxHelperDeathKillsTheMemberTree(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := listener.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	cmd := process.Command(ctx, t.TempDir(), os.Args[0], "--merak-sandbox-windows-helper", listener.Addr().String(), "fixture-token")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var identity struct{ Token, AccountSID string }
	if err := json.NewDecoder(connection).Decode(&identity); err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(connection).Encode(map[string]any{
		"command": os.Args[0], "args": []string{"-test.run=^TestSandboxChild$", "--", "spawn-wait", "unused"},
		"directory": cmd.Dir, "env": []string{"SystemRoot=" + os.Getenv("SystemRoot")},
	}); err != nil {
		t.Fatal(err)
	}
	var started struct {
		Ready bool
		Error string
	}
	if err := json.NewDecoder(connection).Decode(&started); err != nil || !started.Ready {
		t.Fatalf("member startup: %+v %v", started, err)
	}
	if err := json.NewEncoder(connection).Encode(true); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewScanner(stdout)
	var descendant, member uint32
	for reader.Scan() {
		if strings.HasPrefix(reader.Text(), "child:") {
			if _, err := fmt.Sscanf(reader.Text(), "child:%d parent:%d", &descendant, &member); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if descendant == 0 {
		t.Fatalf("member did not start its child: %v", reader.Err())
	}
	memberHandle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, member)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(memberHandle)
	defer func() { windows.TerminateProcess(memberHandle, 1); windows.WaitForSingleObject(memberHandle, 2000) }()
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, descendant)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	defer windows.TerminateProcess(handle, 1)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	state, err := windows.WaitForSingleObject(handle, 2000)
	if err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatalf("descendant survived helper death: state=%d error=%v", state, err)
	}
}
