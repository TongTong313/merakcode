package cli

import (
	"bytes"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/server"
)

// engineProcess is the process id the connection file of the engine names.
func engineProcess(t *testing.T, home string) int {
	t.Helper()
	info, err := server.ReadInfo(filepath.Join(home, "data"))
	if err != nil {
		t.Fatal(err)
	}
	return info.PID
}

// parsePlist decodes the dictionary of a property list into strings, bools, []any and map[string]any.
func parsePlist(t *testing.T, body []byte) map[string]any {
	t.Helper()
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var read func(start xml.StartElement) any
	next := func() xml.Token {
		for {
			token, err := decoder.Token()
			if err != nil {
				t.Fatalf("plist is not well formed: %v\n%s", err, body)
			}
			if text, ok := token.(xml.CharData); ok && strings.TrimSpace(string(text)) == "" {
				continue
			}
			return token
		}
	}
	text := func() string {
		var value strings.Builder
		for {
			token, err := decoder.Token()
			if err != nil {
				t.Fatal(err)
			}
			switch token := token.(type) {
			case xml.CharData:
				value.Write(token)
			case xml.EndElement:
				return value.String()
			}
		}
	}
	read = func(start xml.StartElement) any {
		switch start.Name.Local {
		case "string":
			return text()
		case "true":
			text()
			return true
		case "false":
			text()
			return false
		case "array":
			list := []any{}
			for {
				token := next()
				if _, end := token.(xml.EndElement); end {
					return list
				}
				list = append(list, read(token.(xml.StartElement)))
			}
		case "dict":
			entries := map[string]any{}
			for {
				token := next()
				if _, end := token.(xml.EndElement); end {
					return entries
				}
				key := text()
				entries[key] = read(next().(xml.StartElement))
			}
		}
		t.Fatalf("unexpected plist element %s", start.Name.Local)
		return nil
	}
	for {
		token := next()
		if start, ok := token.(xml.StartElement); ok && start.Name.Local == "dict" {
			return read(start).(map[string]any)
		}
	}
}

func TestLaunchAgentPlistStartsTheEngineAtLogin(t *testing.T) {
	for _, test := range []struct {
		name, executable, root string
	}{
		{"plain path", "/usr/local/bin/merak", ""},
		{"spaces and XML characters", `/Applications/Merak & Co <beta>/merak`, ""},
		{"with a data root", "/opt/merak/merak", `/Users/me/merak "data"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := launchAgentPlist(test.executable, test.root)
			if err != nil {
				t.Fatal(err)
			}
			plist := parsePlist(t, body)
			if plist["Label"] != "com.merakcode.merak" || plist["RunAtLoad"] != true {
				t.Errorf("plist=%v", plist)
			}
			arguments, _ := plist["ProgramArguments"].([]any)
			if len(arguments) != 2 || arguments[0] != test.executable || arguments[1] != "serve" {
				t.Errorf("ProgramArguments=%v", arguments)
			}
			if _, kept := plist["KeepAlive"]; kept {
				t.Error("KeepAlive would restart an engine the user stopped")
			}
			environment, hasEnvironment := plist["EnvironmentVariables"].(map[string]any)
			if test.root == "" && hasEnvironment {
				t.Errorf("unexpected environment %v", environment)
			}
			if test.root != "" && environment["MERAKCODE_HOME"] != test.root {
				t.Errorf("environment=%v", environment)
			}
			if !bytes.HasPrefix(body, []byte("<?xml")) || !bytes.Contains(body, []byte("<!DOCTYPE plist")) {
				t.Errorf("not a property list document:\n%s", body)
			}
		})
	}
}

func TestSystemdUnitStartsTheEngineAtLogin(t *testing.T) {
	for _, test := range []struct {
		name, executable, root string
		want                   []string
		absent                 []string
	}{
		{"plain path", "/usr/local/bin/merak", "", []string{`ExecStart="/usr/local/bin/merak" serve`}, []string{"Environment="}},
		{"spaces", "/opt/Merak Code/merak", "", []string{`ExecStart="/opt/Merak Code/merak" serve`}, nil},
		{"specifiers and variables", `/opt/100%/$HOME/merak`, "", []string{`ExecStart="/opt/100%%/$$HOME/merak" serve`}, nil},
		{"quotes and backslashes", `/opt/a"b\c/merak`, "", []string{`ExecStart="/opt/a\"b\\c/merak" serve`}, nil},
		{"with a data root", "/opt/merak", `/home/me/data 1`, []string{`Environment="MERAKCODE_HOME=/home/me/data 1"`}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, err := systemdUnit(test.executable, test.root)
			if err != nil {
				t.Fatal(err)
			}
			unit := string(body)
			for _, want := range append([]string{"[Unit]\n", "[Service]\n", "[Install]\nWantedBy=default.target\n", "Type=simple\n"}, test.want...) {
				if !strings.Contains(unit, want) {
					t.Errorf("unit lacks %q:\n%s", want, unit)
				}
			}
			for _, absent := range append([]string{"Restart="}, test.absent...) {
				if strings.Contains(unit, absent) {
					t.Errorf("unit contains %q:\n%s", absent, unit)
				}
			}
			if strings.Index(unit, "[Unit]") > strings.Index(unit, "[Service]") || strings.Index(unit, "[Service]") > strings.Index(unit, "[Install]") {
				t.Errorf("sections are out of order:\n%s", unit)
			}
		})
	}
}

// win joins the parts of a Windows path; the tests spell them out so they read the same on every system.
func win(parts ...string) string { return strings.Join(parts, `\`) }

func TestWindowsRunCommandStartsTheEngineThroughTheLauncher(t *testing.T) {
	for _, executable := range []string{
		win("C:", "Program Files", "MerakCode", "merak.exe"),
		win("D:", "Users", "dev", "bin", "merak.exe"),
		win("", "", "server", "share", "merak.exe"),
	} {
		got, err := windowsRunCommand(executable)
		if want := `"` + executable + `" service launch`; err != nil || got != want {
			t.Errorf("windowsRunCommand(%q)=%q, %v; want %q", executable, got, err, want)
		}
	}
}

func TestServiceFilesRefuseValuesThatCouldBreakOutOfTheirLine(t *testing.T) {
	for _, executable := range []string{"", "merak", "/opt/merak\nExecStop=/bin/sh", "/opt/merak\r", "/opt/me\x00rak"} {
		if _, err := launchAgentPlist(executable, ""); err == nil {
			t.Errorf("launchAgentPlist accepted %q", executable)
		}
		if _, err := systemdUnit(executable, ""); err == nil {
			t.Errorf("systemdUnit accepted %q", executable)
		}
	}
	for _, root := range []string{"/data\nExecStop=/bin/sh", "/da\x00ta"} {
		if _, err := systemdUnit("/opt/merak", root); err == nil {
			t.Errorf("systemdUnit accepted root %q", root)
		}
		if _, err := launchAgentPlist("/opt/merak", root); err == nil {
			t.Errorf("launchAgentPlist accepted root %q", root)
		}
	}
	for _, executable := range []string{"", "merak.exe", win("", "Users", "merak.exe"), win("C:", `a"b`, "merak.exe"), win("C:", "merak.exe\n"), win("C:", "me\x00rak.exe")} {
		if _, err := windowsRunCommand(executable); err == nil {
			t.Errorf("windowsRunCommand accepted %q", executable)
		}
	}
}

func TestLaunchAgentFileIsWrittenReplacedAndRemoved(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "Library", "LaunchAgents", "com.merakcode.merak.plist")
	if got := launchAgentPath(home); got != path {
		t.Fatalf("path=%q want %q", got, path)
	}
	if err := installLaunchAgent(home, "/opt/one/merak", ""); err != nil {
		t.Fatal(err)
	}
	if plist := parsePlist(t, readFile(t, path)); plist["ProgramArguments"].([]any)[0] != "/opt/one/merak" {
		t.Fatalf("plist=%v", plist)
	}
	if err := installLaunchAgent(home, "/opt/two/merak", ""); err != nil {
		t.Fatal(err)
	}
	if plist := parsePlist(t, readFile(t, path)); plist["ProgramArguments"].([]any)[0] != "/opt/two/merak" {
		t.Fatalf("a second install did not replace the file: %v", plist)
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatalf("install left other files behind: %v", entries)
	}
	if err := uninstallLaunchAgent(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the plist remains: %v", err)
	}
	if err := uninstallLaunchAgent(home); err != nil {
		t.Fatalf("uninstalling twice failed: %v", err)
	}
}

func TestSystemdUnitFileIsWrittenReplacedAndRemoved(t *testing.T) {
	config := t.TempDir()
	path := filepath.Join(config, "systemd", "user", "merakcode.service")
	if got := systemdUnitPath(config); got != path {
		t.Fatalf("path=%q want %q", got, path)
	}
	if err := writeSystemdUnit(config, "/opt/one/merak", ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(readFile(t, path)), `ExecStart="/opt/one/merak" serve`) {
		t.Fatalf("unit:\n%s", readFile(t, path))
	}
	if err := writeSystemdUnit(config, "/opt/two/merak", ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(readFile(t, path)), `ExecStart="/opt/two/merak" serve`) {
		t.Fatalf("a second install did not replace the unit:\n%s", readFile(t, path))
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatalf("install left other files behind: %v", entries)
	}
	if err := removeSystemdUnit(config); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the unit remains: %v", err)
	}
	if err := removeSystemdUnit(config); err != nil {
		t.Fatalf("removing twice failed: %v", err)
	}
}

func TestSystemdConfigHomeFollowsTheXDGVariable(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	if got := systemdConfigHome("/home/me"); got != filepath.Join("/home/me", ".config") {
		t.Errorf("default=%q", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "relative/path")
	if got := systemdConfigHome("/home/me"); got != filepath.Join("/home/me", ".config") {
		t.Errorf("a relative value must be ignored, got %q", got)
	}
	absolute := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", absolute)
	if got := systemdConfigHome("/home/me"); got != absolute {
		t.Errorf("absolute=%q", got)
	}
}

func TestServiceCommandRejectsUnknownUsage(t *testing.T) {
	for _, args := range [][]string{{"service"}, {"service", "explode"}, {"service", "install", "extra"}, {"service", "uninstall", "extra"}, {"service", "launch", "extra"}} {
		var out bytes.Buffer
		if code := Run(args, strings.NewReader(""), &out); code != 2 {
			t.Errorf("%v: code=%d", args, code)
		}
	}
}

func TestServiceErrorsCarryTheirCodes(t *testing.T) {
	failure := errors.New("disk full")
	for _, test := range []struct {
		name      string
		err       error
		install   bool
		wantCode  string
		wantTitle string
	}{
		{"install fails", failure, true, "MRK-5014", "Could not set up start at login"},
		{"uninstall fails", failure, false, "MRK-5015", "Could not remove start at login"},
		{"unsupported install", errServiceUnsupported, true, "MRK-5016", "not supported"},
		{"unsupported uninstall", errServiceUnsupported, false, "MRK-5016", "not supported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var out bytes.Buffer
			ui := &renderer{language: "en"}
			reportService(&out, ui, test.err, test.install)
			if !strings.Contains(out.String(), "["+test.wantCode+"]") || !strings.Contains(out.String(), test.wantTitle) {
				t.Errorf("output=%q", out.String())
			}
			out.Reset()
			reportService(&out, &renderer{language: "zh"}, test.err, test.install)
			if !strings.Contains(out.String(), "["+test.wantCode+"]") {
				t.Errorf("zh output=%q", out.String())
			}
		})
	}
}

func TestServiceLaunchStartsTheEngineOnlyOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	cleanupEngine(t, home)
	var out bytes.Buffer
	if code := Run([]string{"service", "launch"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("first launch: code=%d output=%q", code, out.String())
	}
	first := engineProcess(t, home)
	if code := Run([]string{"service", "launch"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("second launch: code=%d output=%q", code, out.String())
	}
	if second := engineProcess(t, home); second != first {
		t.Fatalf("the second launch started another engine: %d then %d", first, second)
	}
	if code := Run([]string{"stop"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("stop=%d", code)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
