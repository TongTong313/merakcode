//go:build windows && sandbox_integration

package sandbox_test

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestWindowsMemberProxyRejectsConnectionsWithoutItsCredential(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool")
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("private proxy")) }))
	defer target.Close()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}, Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{target.Listener.Addr().(*net.TCPAddr).Port}}}
	cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var env []string
	if err := json.Unmarshal(out, &env); err != nil {
		t.Fatal(err)
	}
	var address *url.URL
	for _, value := range env {
		if strings.HasPrefix(value, "HTTP_PROXY=") {
			address, err = url.Parse(strings.TrimPrefix(value, "HTTP_PROXY="))
		}
	}
	if err != nil || address == nil {
		t.Fatal("missing proxy address")
	}
	address.User = nil
	transport := &http.Transport{Proxy: http.ProxyURL(address)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusProxyAuthRequired {
		t.Fatalf("unauthenticated proxy response=%d", response.StatusCode)
	}
}

func TestWindowsMemberUsesTheEngineNetworkProxy(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool")
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("proxied")) }))
	defer target.Close()
	var approvals atomic.Int32
	launcher := &sandbox.Launcher{StateDir: state, ApproveNetwork: func(_ context.Context, host string) (bool, error) {
		if host != "unknown.example.com" {
			t.Errorf("unexpected approval target: %q", host)
		}
		approvals.Add(1)
		return false, nil
	}}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}, Network: sandbox.Network{Mode: "allowlist", LocalPorts: []int{target.Listener.Addr().(*net.TCPAddr).Port}}}
	for _, test := range []struct {
		name, target string
		allowed      bool
	}{
		{"allowed destination", target.URL, true},
		{"unapproved destination", "http://unknown.example.com/", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", "fetch-proxy", test.target)
			if err != nil {
				t.Fatal(err)
			}
			out, err := cmd.CombinedOutput()
			if test.allowed && (err != nil || string(out) != "proxied") {
				t.Fatalf("proxy response=%q error=%v", out, err)
			}
			if !test.allowed && err == nil {
				t.Fatal("unapproved request succeeded")
			}
		})
	}
	if approvals.Load() != 1 {
		t.Fatalf("approvals=%d, expected one", approvals.Load())
	}
}

func TestWindowsFirewallReportsItsLocalNetworkLimits(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("direct loopback")) }))
	defer target.Close()
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}, Network: sandbox.Network{Mode: "off"}}
	cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestSandboxChild$", "--", "fetch", target.URL)
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.CombinedOutput()
	if err != nil || string(out) != "direct loopback" {
		t.Fatalf("loopback capability=%q error=%v", out, err)
	}
	t.Log("member reached the local fixture directly without using the proxy")
	status := launcher.Status(t.Context(), p)
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var reported struct{ Limits []string }
	if err := json.Unmarshal(encoded, &reported); err != nil {
		t.Fatal(err)
	}
	if !status.Available || status.Network != "account" || !slices.Equal(reported.Limits, []string{"loopback-open", "own-addresses-open"}) {
		t.Fatalf("partial isolation status=%+v", status)
	}
}

func TestWindowsStatusDetectsChangedAndRestoredCredentials(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	body, err := os.ReadFile(filepath.Join(state, "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct{ Accounts []struct{ Credential string } }
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Accounts) != 2 {
		t.Fatal("credential test requires the isolated two-account pool")
	}
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}}
	if status := launcher.Status(t.Context(), p); !status.Available {
		t.Fatalf("initial status=%+v", status)
	}
	type credential struct {
		Flags, Type     uint32
		Target, Comment *uint16
		Written         windows.Filetime
		BlobSize        uint32
		Blob            *byte
		Persist, Count  uint32
		Attributes      uintptr
		Alias, Username *uint16
	}
	target, err := windows.UTF16PtrFromString(manifest.Accounts[0].Credential)
	if err != nil {
		t.Fatal(err)
	}
	api := windows.NewLazySystemDLL("advapi32.dll")
	var saved *credential
	if ok, _, err := api.NewProc("CredReadW").Call(uintptr(unsafe.Pointer(target)), 1, 0, uintptr(unsafe.Pointer(&saved))); ok == 0 {
		t.Fatal(err)
	}
	defer api.NewProc("CredFree").Call(uintptr(unsafe.Pointer(saved)))
	restore := func() {
		if ok, _, err := api.NewProc("CredWriteW").Call(uintptr(unsafe.Pointer(saved)), 0); ok == 0 {
			t.Fatal(err)
		}
	}
	defer restore()
	invalid := *saved
	password, _ := windows.UTF16FromString("Invalid-S25-Fixture-Password")
	invalid.Blob, invalid.BlobSize = (*byte)(unsafe.Pointer(&password[0])), uint32((len(password)-1)*2)
	if ok, _, err := api.NewProc("CredWriteW").Call(uintptr(unsafe.Pointer(&invalid)), 0); ok == 0 {
		t.Fatal(err)
	}
	runtime.KeepAlive(password)
	if status := launcher.Status(t.Context(), p); status.Available || status.Reason == "" {
		t.Fatalf("invalid credential status=%+v", status)
	}
	restore()
	if status := launcher.Status(t.Context(), p); !status.Available {
		t.Fatalf("restored credential status=%+v", status)
	}
}

func TestWindowsMemberCannotAccessTheInteractiveWindowStation(t *testing.T) {
	state := os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")
	if state == "" {
		t.Fatal("initialize the isolated test account pool and set MERAKCODE_SANDBOX_TEST_STATE")
	}
	launcher := &sandbox.Launcher{StateDir: state}
	defer launcher.Close()
	p := sandbox.Profile{WriteAllow: []string{t.TempDir()}, EnvAllow: []string{"SystemRoot"}}
	cmd, err := launcher.Command(t.Context(), p, os.Args[0], "-test.run=^TestWindowsWindowStationFixture$", "--", "window-station")
	if err != nil {
		t.Fatal(err)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("interactive station was accessible: %v %s", err, out)
	}
}

func TestWindowsWindowStationFixture(t *testing.T) {
	if os.Args[len(os.Args)-1] != "window-station" {
		return
	}
	api := windows.NewLazySystemDLL("user32.dll")
	station, _, err := api.NewProc("GetProcessWindowStation").Call()
	if station == 0 {
		t.Fatal(err)
	}
	var needed uint32
	name := make([]uint16, 256)
	if ok, _, err := api.NewProc("GetUserObjectInformationW").Call(station, 2, uintptr(unsafe.Pointer(&name[0])), uintptr(len(name)*2), uintptr(unsafe.Pointer(&needed))); ok == 0 {
		t.Fatal(err)
	}
	if windows.UTF16ToString(name) == "WinSta0" {
		t.Fatal("member inherited the interactive window station")
	}
	interactive, _ := windows.UTF16PtrFromString("WinSta0")
	if handle, _, _ := api.NewProc("OpenWindowStationW").Call(uintptr(unsafe.Pointer(interactive)), 0, 4); handle != 0 {
		api.NewProc("CloseWindowStation").Call(handle)
		t.Fatal("member can open the interactive clipboard")
	}
}
