package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
)

func TestUpgradeAnswersWithTheNotAvailableCodeInBothLanguages(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for language, title := range map[string]string{"en": "not available yet", "zh": "暂时不能在命令行里升级"} {
		for _, args := range [][]string{{"upgrade"}, {"upgrade", "1.2.3"}, {"upgrade", "v0.4.0-beta.1"}} {
			var out bytes.Buffer
			code := Run(append([]string{"--lang", language}, args...), strings.NewReader(""), &out)
			if code != 1 || !strings.Contains(out.String(), "[MRK-4016]") || !strings.Contains(out.String(), title) {
				t.Errorf("%s %v: code=%d output=%q", language, args, code, out.String())
			}
		}
	}
}

func TestUpgradeRejectsAVersionThatIsNotAVersion(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for _, version := range []string{"latest", "1.2", "1.2.3.4", "../1.2.3", "1.2.3 --force"} {
		var out bytes.Buffer
		if code := Run([]string{"upgrade", version}, strings.NewReader(""), &out); code != 2 {
			t.Errorf("%q: code=%d output=%q", version, code, out.String())
		}
	}
	var out bytes.Buffer
	if code := Run([]string{"upgrade", "1.2.3", "1.2.4"}, strings.NewReader(""), &out); code != 2 {
		t.Errorf("two versions: code=%d", code)
	}
}

func TestUpgradeAsksToStopARunningEngineFirst(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	var out bytes.Buffer
	if code := Run([]string{"upgrade"}, strings.NewReader(""), &out); code != 1 || strings.Contains(out.String(), "merak stop") {
		t.Fatalf("without an engine: code=%d output=%q", code, out.String())
	}
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	out.Reset()
	if code := Run([]string{"upgrade"}, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "merak stop") {
		t.Fatalf("with an engine: code=%d output=%q", code, out.String())
	}
}

func TestUpgradeOfTheDesktopCopyOnlyPointsToTheDesktop(t *testing.T) {
	root := t.TempDir()
	desktop := filepath.Join(root, "app", "resources", "merak", "merak")
	standalone := filepath.Join(root, "bin", "merak")
	for _, path := range []string{desktop, standalone, filepath.Join(root, "app", "resources", "app.asar")} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name, executable string
		desktop          bool
	}{
		{"packaged with the desktop app", desktop, true},
		{"standalone program", standalone, false},
		{"unknown path", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := installedByDesktop(test.executable); got != test.desktop {
				t.Fatalf("installedByDesktop(%q)=%v", test.executable, got)
			}
		})
	}
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	t.Setenv("MERAKCODE_LANG", "en")
	var out bytes.Buffer
	ui := &renderer{language: "en"}
	if code := upgradeFrom(desktop, nil, &out, ui); code != 0 || !strings.Contains(out.String(), "desktop app") || strings.Contains(out.String(), "MRK-4016") {
		t.Fatalf("desktop copy: code=%d output=%q", code, out.String())
	}
}
