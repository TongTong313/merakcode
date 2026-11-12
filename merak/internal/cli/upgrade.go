package cli

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

var versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)

// upgradeCommand runs merak upgrade [version]. The download address and the checksum file are decided by the
// release process, which does not exist yet, so after the checks that do not depend on it the command answers that
// upgrading is not available.
func upgradeCommand(args []string, output io.Writer, ui *renderer) int {
	executable, err := os.Executable()
	if err != nil {
		executable = ""
	}
	return upgradeFrom(executable, args, output, ui)
}

func upgradeFrom(executable string, args []string, output io.Writer, ui *renderer) int {
	if len(args) > 1 || len(args) == 1 && !versionPattern.MatchString(args[0]) {
		return 2
	}
	if installedByDesktop(executable) {
		if _, err := io.WriteString(output, ui.text("upgradeDesktop")); err != nil {
			return 1
		}
		return 0
	}
	if engineRunning() {
		if _, err := io.WriteString(output, ui.text("upgradeStopEngine")); err != nil {
			return 1
		}
	}
	ui.failure(output, errorcode.UpgradeUnavailable)
	return 1
}

// installedByDesktop tells whether the program is the copy the desktop app carries in its resources folder, as in
// <resources>/merak/merak, next to the app archive. The desktop app updates that copy itself.
func installedByDesktop(executable string) bool {
	if executable == "" {
		return false
	}
	folder := filepath.Dir(executable)
	if filepath.Base(folder) != "merak" {
		return false
	}
	resources := filepath.Dir(folder)
	for _, name := range []string{"app.asar", "app"} {
		if _, err := os.Stat(filepath.Join(resources, name)); err == nil {
			return true
		}
	}
	return false
}

func engineRunning() bool {
	home, err := dataHome()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := connectEngine(ctx, home)
	if err != nil {
		return false
	}
	_ = client.Close()
	return true
}
