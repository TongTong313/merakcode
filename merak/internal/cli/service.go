package cli

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

const (
	launchAgentLabel = "com.merakcode.merak"
	systemdUnitName  = "merakcode.service"
	// windowsRunName is the name of the value under the current user's Run key.
	windowsRunName = "MerakCode"
)

// errServiceUnsupported says the system has no login item this command can write.
var errServiceUnsupported = errors.New("start at login is not supported here")

// serviceCommand runs merak service install, uninstall and launch. install and uninstall make the engine start when
// the user logs in, for this user only and at login rather than at boot; launch is what the Windows login item runs.
func serviceCommand(args []string, output io.Writer, ui *renderer) int {
	if len(args) != 1 {
		return 2
	}
	switch args[0] {
	case "install":
		executable, err := os.Executable()
		if err == nil {
			if resolved, linkErr := filepath.EvalSymlinks(executable); linkErr == nil {
				executable = resolved
			}
			err = installService(executable, os.Getenv("MERAKCODE_HOME"))
		}
		if err != nil {
			reportService(output, ui, err, true)
			return 1
		}
		if _, err := fmt.Fprint(output, ui.text("serviceInstalled")); err != nil {
			return 1
		}
		return 0
	case "uninstall":
		if err := uninstallService(); err != nil {
			reportService(output, ui, err, false)
			return 1
		}
		if _, err := fmt.Fprint(output, ui.text("serviceUninstalled")); err != nil {
			return 1
		}
		return 0
	case "launch":
		return launchEngine()
	}
	return 2
}

// reportService prints the error code of a failed install or uninstall.
func reportService(output io.Writer, ui *renderer, err error, install bool) {
	switch {
	case errors.Is(err, errServiceUnsupported):
		ui.failure(output, errorcode.ServiceUnsupported)
	case install:
		ui.failure(output, errorcode.ServiceInstallFailed)
	default:
		ui.failure(output, errorcode.ServiceUninstallFailed)
	}
}

// launchEngine starts the engine when it does not run and returns at once. The Windows login item runs it because a
// console program started by the Run key would keep a console window open for as long as the engine lives.
func launchEngine() int {
	home, err := dataHome()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return 1
	}
	_ = client.Close()
	return 0
}

// checkServiceText refuses text that could end its line in a unit or a command: control characters.
func checkServiceText(value string) error {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return errors.New("a login item value contains a control character")
		}
	}
	return nil
}

// checkServicePaths validates the program path (an absolute path that matches isAbs) and the optional data root.
func checkServicePaths(executable, root string, isAbs func(string) bool) error {
	if executable == "" || !isAbs(executable) {
		return errors.New("the program path must be absolute")
	}
	if err := checkServiceText(executable); err != nil {
		return err
	}
	return checkServiceText(root)
}

// launchAgentPlist is the property list of the macOS LaunchAgent that runs merak serve at login. It has no KeepAlive,
// so an engine that the user stopped stays stopped. A data root is passed on as MERAKCODE_HOME.
func launchAgentPlist(executable, root string) ([]byte, error) {
	if err := checkServicePaths(executable, root, path.IsAbs); err != nil {
		return nil, err
	}
	var body bytes.Buffer
	text := func(value string) string {
		var escaped bytes.Buffer
		_ = xml.EscapeText(&escaped, []byte(value))
		return escaped.String()
	}
	body.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	body.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	body.WriteString("<plist version=\"1.0\">\n<dict>\n")
	body.WriteString("\t<key>Label</key>\n\t<string>" + launchAgentLabel + "</string>\n")
	body.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>" + text(executable) + "</string>\n\t\t<string>serve</string>\n\t</array>\n")
	if root != "" {
		body.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n\t\t<key>MERAKCODE_HOME</key>\n\t\t<string>" + text(root) + "</string>\n\t</dict>\n")
	}
	body.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	body.WriteString("</dict>\n</plist>\n")
	return body.Bytes(), nil
}

// systemdQuote quotes one word of a unit file: inside double quotes a backslash and a quote are escaped, and the
// characters systemd expands itself, % (specifiers) and $ (variables), are doubled.
func systemdQuote(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "%", "%%", "$", "$$")
	return `"` + replacer.Replace(value) + `"`
}

// systemdUnit is the user unit that runs merak serve at login. It has no Restart, so an engine that the user stopped
// stays stopped. A data root is passed on as MERAKCODE_HOME.
func systemdUnit(executable, root string) ([]byte, error) {
	if err := checkServicePaths(executable, root, path.IsAbs); err != nil {
		return nil, err
	}
	var body strings.Builder
	body.WriteString("[Unit]\nDescription=MerakCode engine\n\n")
	body.WriteString("[Service]\nType=simple\n")
	if root != "" {
		body.WriteString("Environment=" + systemdQuote("MERAKCODE_HOME="+root) + "\n")
	}
	body.WriteString("ExecStart=" + systemdQuote(executable) + " serve\n\n")
	body.WriteString("[Install]\nWantedBy=default.target\n")
	return []byte(body.String()), nil
}

// windowsRunCommand is the command of the Run value: the launcher of the engine, with the program path quoted.
func windowsRunCommand(executable string) (string, error) {
	drive := len(executable) >= 3 && (executable[0] >= 'A' && executable[0] <= 'Z' || executable[0] >= 'a' && executable[0] <= 'z') && executable[1] == ':' && (executable[2] == '\\' || executable[2] == '/')
	if !drive && !strings.HasPrefix(executable, `\\`) || strings.ContainsRune(executable, '"') {
		return "", errors.New("the program path must be absolute and contain no quote")
	}
	if err := checkServiceText(executable); err != nil {
		return "", err
	}
	return `"` + executable + `" service launch`, nil
}

func launchAgentPath(userHome string) string {
	return filepath.Join(userHome, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

// installLaunchAgent writes the LaunchAgent. launchd reads the folder at the next login, so nothing is loaded now and
// no engine starts or stops because of it.
func installLaunchAgent(userHome, executable, root string) error {
	body, err := launchAgentPlist(executable, root)
	if err != nil {
		return err
	}
	return writeServiceFile(launchAgentPath(userHome), body)
}

func uninstallLaunchAgent(userHome string) error {
	return removeServiceFile(launchAgentPath(userHome))
}

// systemdConfigHome is the folder user units live under: XDG_CONFIG_HOME when it is an absolute path, else ~/.config.
func systemdConfigHome(userHome string) string {
	if value := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(userHome, ".config")
}

func systemdUnitPath(configHome string) string {
	return filepath.Join(configHome, "systemd", "user", systemdUnitName)
}

func writeSystemdUnit(configHome, executable, root string) error {
	body, err := systemdUnit(executable, root)
	if err != nil {
		return err
	}
	return writeServiceFile(systemdUnitPath(configHome), body)
}

func removeSystemdUnit(configHome string) error {
	return removeServiceFile(systemdUnitPath(configHome))
}

// writeServiceFile replaces the file in one step, so a reader never sees half of it.
func writeServiceFile(target string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(target), ".merak-login-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.Write(body); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(0o644); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}

// removeServiceFile deletes the file; a file that is already gone is not an error.
func removeServiceFile(target string) error {
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
