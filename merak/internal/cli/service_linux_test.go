//go:build linux

package cli

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestServiceCommandWritesTheUnitAndEnablesItWithSystemd(t *testing.T) {
	if _, err := exec.LookPath("systemctl"); err != nil {
		t.Skip("systemctl is not installed, so install and uninstall report that the system is not supported")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("MERAKCODE_HOME", filepath.Join(home, "merak-data"))
	var calls [][]string
	previous := systemctl
	systemctl = func(args ...string) error {
		calls = append(calls, args)
		return nil
	}
	t.Cleanup(func() { systemctl = previous })
	unit := filepath.Join(home, ".config", "systemd", "user", "merakcode.service")

	var out bytes.Buffer
	if code := Run([]string{"--lang", "en", "service", "install"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("install: code=%d output=%q", code, out.String())
	}
	body := string(readFile(t, unit))
	if !strings.Contains(body, `Environment="MERAKCODE_HOME=`+filepath.Join(home, "merak-data")+`"`) || !strings.Contains(body, " serve\n") {
		t.Fatalf("unit:\n%s", body)
	}
	if want := [][]string{{"daemon-reload"}, {"enable", "merakcode.service"}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("install calls=%v want %v", calls, want)
	}

	calls = nil
	if code := Run([]string{"--lang", "en", "service", "uninstall"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("uninstall: code=%d output=%q", code, out.String())
	}
	if want := [][]string{{"disable", "merakcode.service"}, {"daemon-reload"}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("uninstall calls=%v want %v", calls, want)
	}
	if _, err := os.Stat(unit); !os.IsNotExist(err) {
		t.Fatal("the unit remains after uninstall")
	}
}
