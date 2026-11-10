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
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return errors.New("MRK-5004")
	}
	executable, err := os.Executable()
	if err != nil {
		return errors.New("MRK-5004")
	}
	temporary, err := os.MkdirTemp("", "merak-sandbox-setup-")
	if err != nil {
		return errors.New("MRK-5004")
	}
	defer os.RemoveAll(temporary)
	if err := privateStatePath(temporary, true); err != nil {
		return errors.New("MRK-5004")
	}
	for _, name := range []string{"setup-windows.ps1", "credential-windows.ps1", "grant-read-windows.ps1"} {
		body, err := initializationScripts.ReadFile("scripts/" + name)
		if err != nil {
			return errors.New("MRK-5004")
		}
		if err := os.WriteFile(filepath.Join(temporary, name), body, 0600); err != nil {
			return errors.New("MRK-5004")
		}
	}
	literal := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	elevated := "$ErrorActionPreference='Stop'; if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne " + literal(user.User.Sid.String()) + ") { exit 1 }; & " + literal(filepath.Join(temporary, "setup-windows.ps1")) + " -StateDir " + literal(directory) + "; & " + literal(filepath.Join(temporary, "grant-read-windows.ps1")) + " -StateDir " + literal(directory) + " -InstallDir " + literal(filepath.Dir(executable)) + "; exit 0"
	encode := func(script string) string {
		units := utf16.Encode([]rune(script))
		body := make([]byte, len(units)*2)
		for i, value := range units {
			binary.LittleEndian.PutUint16(body[i*2:], value)
		}
		return base64.StdEncoding.EncodeToString(body)
	}
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	script := "$ErrorActionPreference='Stop'; $setup = Start-Process -FilePath " + literal(powershell) + " -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand'," + literal(encode(elevated)) + "); exit $setup.ExitCode"
	if err := ctx.Err(); err != nil {
		return err
	}
	// Once elevation starts, wait for it before removing the scripts it is using.
	if err := process.Command(context.WithoutCancel(ctx), "", powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encode(script)).Run(); err != nil {
		return errors.New("MRK-5004")
	}
	if !launcher.platformStatus(ctx, Profile{}).Available {
		return errors.New("MRK-5004")
	}
	return nil
}
