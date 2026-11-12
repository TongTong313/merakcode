package sandbox

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"golang.org/x/sys/windows"
)

//go:embed scripts/*.ps1
var initializationScripts embed.FS

func initialize(ctx context.Context, directory string) error {
	launcher := &Launcher{StateDir: directory}
	if launcher.platformStatus(ctx, Profile{}).Available {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return errors.New("MRK-5004")
	}
	err = runElevated(ctx, "MRK-5004", []string{"setup-windows.ps1", "credential-windows.ps1", "grant-read-windows.ps1"}, func(temporary string) string {
		return "& " + powershellLiteral(filepath.Join(temporary, "setup-windows.ps1")) + " -StateDir " + powershellLiteral(directory) + "; & " + powershellLiteral(filepath.Join(temporary, "grant-read-windows.ps1")) + " -StateDir " + powershellLiteral(directory) + " -InstallDir " + powershellLiteral(filepath.Dir(executable))
	})
	if err != nil {
		return err
	}
	if !launcher.platformStatus(ctx, Profile{}).Available {
		return errors.New("MRK-5004")
	}
	return nil
}

func powershellLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

// runElevated copies the named embedded scripts to a private temporary folder and runs the command that body builds
// from that folder in a PowerShell that Windows asks the user to approve as administrator. The elevated shell
// refuses to run for any account other than the one that asked. Every failure is reported as code.
func runElevated(ctx context.Context, code string, scripts []string, body func(temporary string) string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return errors.New(code)
	}
	temporary, err := os.MkdirTemp("", "merak-sandbox-setup-")
	if err != nil {
		return errors.New(code)
	}
	defer os.RemoveAll(temporary)
	if err := privateStatePath(temporary, true); err != nil {
		return errors.New(code)
	}
	for _, name := range scripts {
		script, err := initializationScripts.ReadFile("scripts/" + name)
		if err != nil {
			return errors.New(code)
		}
		if err := os.WriteFile(filepath.Join(temporary, name), script, 0600); err != nil {
			return errors.New(code)
		}
	}
	elevated := "$ErrorActionPreference='Stop'; if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne " + powershellLiteral(user.User.Sid.String()) + ") { exit 1 }; " + body(temporary) + "; exit 0"
	encode := func(script string) string {
		units := utf16.Encode([]rune(script))
		bytes := make([]byte, len(units)*2)
		for i, value := range units {
			binary.LittleEndian.PutUint16(bytes[i*2:], value)
		}
		return base64.StdEncoding.EncodeToString(bytes)
	}
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	script := "$ErrorActionPreference='Stop'; $setup = Start-Process -FilePath " + powershellLiteral(powershell) + " -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand'," + powershellLiteral(encode(elevated)) + "); exit $setup.ExitCode"
	if err := ctx.Err(); err != nil {
		return err
	}
	// Once elevation starts, wait for it before removing the scripts it is using.
	if err := process.Command(context.WithoutCancel(ctx), "", powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)).Run(); err != nil {
		return errors.New(code)
	}
	return nil
}
