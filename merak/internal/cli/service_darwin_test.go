//go:build darwin

package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceCommandWritesAndRemovesTheLaunchAgent(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("MERAKCODE_HOME", filepath.Join(home, "merak-data"))
	plist := filepath.Join(home, "Library", "LaunchAgents", "com.merakcode.merak.plist")

	var out bytes.Buffer
	if code := Run([]string{"--lang", "en", "service", "install"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("install: code=%d output=%q", code, out.String())
	}
	values := parsePlist(t, readFile(t, plist))
	arguments, _ := values["ProgramArguments"].([]any)
	if len(arguments) != 2 || arguments[1] != "serve" || values["RunAtLoad"] != true {
		t.Fatalf("plist=%v", values)
	}
	if environment, _ := values["EnvironmentVariables"].(map[string]any); environment["MERAKCODE_HOME"] != filepath.Join(home, "merak-data") {
		t.Fatalf("plist=%v", values)
	}
	if code := Run([]string{"--lang", "en", "service", "uninstall"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("uninstall: code=%d output=%q", code, out.String())
	}
	if _, err := os.Stat(plist); !os.IsNotExist(err) {
		t.Fatalf("the plist remains: %v", err)
	}
}
