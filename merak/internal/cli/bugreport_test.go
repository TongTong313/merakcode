package cli

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
)

func TestBugReportWritesThePackageAndPrintsWhereToSendIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
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
	for language, want := range map[string]string{"en": "Bug report saved", "zh": "问题报告已保存"} {
		destination := filepath.Join(t.TempDir(), "report-"+language+".zip")
		var out bytes.Buffer
		if code := Run([]string{"--lang", language, "bug-report", "--out", destination}, strings.NewReader(""), &out); code != 0 {
			t.Fatalf("%s: code=%d output=%q", language, code, out.String())
		}
		for _, expected := range []string{want, destination, "https://github.com/TongTong313/merakcode/issues/new"} {
			if !strings.Contains(out.String(), expected) {
				t.Errorf("%s: output lacks %q:\n%s", language, expected, out.String())
			}
		}
		archive, err := zip.OpenReader(destination)
		if err != nil {
			t.Fatalf("%s: the package is not a zip: %v", language, err)
		}
		if len(archive.File) == 0 {
			t.Errorf("%s: the package is empty", language)
		}
		for _, file := range archive.File {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(reader)
			reader.Close()
			if bytes.Contains(body, []byte(instance.Info.Token)) {
				t.Errorf("%s: %s contains the engine token", language, file.Name)
			}
		}
		archive.Close()
	}
}

func TestBugReportNamesTheFileAfterTheTimeInTheCurrentFolder(t *testing.T) {
	at := time.Date(2026, 11, 12, 9, 8, 7, 0, time.UTC)
	if got := bugReportName(at); got != "merak-bug-report-20261112-090807.zip" {
		t.Fatalf("name=%q", got)
	}
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	folder := t.TempDir()
	t.Chdir(folder)
	var out bytes.Buffer
	if code := Run([]string{"bug-report"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
	matches, err := filepath.Glob(filepath.Join(folder, "merak-bug-report-*.zip"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("matches=%v err=%v", matches, err)
	}
	if _, err := os.Stat(filepath.Join(home, "data", "engine.json")); !os.IsNotExist(err) {
		t.Fatal("bug-report started an engine")
	}
}

func TestBugReportReportsAFailureWithItsCode(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	t.Setenv("MERAKCODE_LANG", "en")
	destination := filepath.Join(t.TempDir(), "missing-folder", "report.zip")
	var out bytes.Buffer
	if code := Run([]string{"bug-report", "--out", destination}, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "[MRK-1004]") {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
	if code := Run([]string{"bug-report", "extra"}, strings.NewReader(""), &out); code != 2 {
		t.Fatalf("extra argument: code=%d", code)
	}
}
