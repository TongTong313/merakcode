//go:build windows

package cli

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// useTemporaryRunKey points the login item at a key of its own, so the tests never touch the real Run key, and
// removes that key when the test ends.
func useTemporaryRunKey(t *testing.T) string {
	t.Helper()
	key := fmt.Sprintf(`HKCU\Software\MerakCodeTest\%d-%s`, os.Getpid(), strings.NewReplacer("/", "-", " ", "-").Replace(t.Name()))
	previous := windowsRunKey
	windowsRunKey = key
	t.Cleanup(func() {
		windowsRunKey = previous
		_ = exec.Command("reg.exe", "delete", key, "/f").Run()
	})
	return key
}

// registryData reads the data of the Run value through the registry API, which keeps non-ASCII characters that the
// console output of reg.exe would garble, or reports that the value does not exist.
func registryData(t *testing.T, key string) (string, bool) {
	t.Helper()
	opened, err := registry.OpenKey(registry.CURRENT_USER, strings.TrimPrefix(key, `HKCU\`), registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	data, _, err := opened.GetStringValue(windowsRunName)
	if errors.Is(err, registry.ErrNotExist) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return data, true
}
func TestWindowsLoginItemIsWrittenReplacedAndRemovedInTheRegistry(t *testing.T) {
	key := useTemporaryRunKey(t)
	first := win("C:", "Program Files", "Merak Code", "merak.exe")
	second := win("D:", "Tools", "merak.exe")
	if err := installService(first, ""); err != nil {
		t.Fatal(err)
	}
	if data, found := registryData(t, key); !found || data != `"`+first+`" service launch` {
		t.Fatalf("data=%q found=%v", data, found)
	}
	if err := installService(second, ""); err != nil {
		t.Fatal(err)
	}
	if data, _ := registryData(t, key); data != `"`+second+`" service launch` {
		t.Fatalf("a second install did not replace the value: %q", data)
	}
	if err := uninstallService(); err != nil {
		t.Fatal(err)
	}
	if _, found := registryData(t, key); found {
		t.Fatal("the value remains after uninstall")
	}
	if err := uninstallService(); err != nil {
		t.Fatalf("uninstalling twice failed: %v", err)
	}
}

func TestWindowsInstallRefusesAPathItCannotQuote(t *testing.T) {
	key := useTemporaryRunKey(t)
	if err := installService(win("C:", `a"b`, "merak.exe"), ""); err == nil {
		t.Fatal("install accepted a path with a quote")
	}
	if _, found := registryData(t, key); found {
		t.Fatal("a value was written for a refused path")
	}
}

func TestServiceCommandInstallsAndUninstallsTheLoginItem(t *testing.T) {
	key := useTemporaryRunKey(t)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	for language, want := range map[string][2]string{"en": {"start at login", "no longer"}, "zh": {"登录时启动", "不再"}} {
		var out bytes.Buffer
		if code := Run([]string{"--lang", language, "service", "install"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), want[0]) {
			t.Fatalf("%s install: code=%d output=%q", language, code, out.String())
		}
		if data, found := registryData(t, key); !found || data != `"`+executable+`" service launch` {
			t.Fatalf("data=%q found=%v want program %q", data, found, executable)
		}
		out.Reset()
		if code := Run([]string{"--lang", language, "service", "uninstall"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), want[1]) {
			t.Fatalf("%s uninstall: code=%d output=%q", language, code, out.String())
		}
		if _, found := registryData(t, key); found {
			t.Fatal("the value remains after uninstall")
		}
	}
}
