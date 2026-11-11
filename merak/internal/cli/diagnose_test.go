package cli

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnoseWritesAnArchiveWithoutStartingTheEngine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	logs := filepath.Join(home, "logs", "production", "engine")
	if err := os.MkdirAll(logs, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logs, "fixture.ndjson"), []byte("{\"msg\":\"ready\",\"token\":\"private-token\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(home, "diagnostics.zip")
	var output bytes.Buffer
	code := Run([]string{"--lang", "en", "diagnose", "--out", destination}, strings.NewReader(""), &output)
	if code != 0 {
		t.Fatalf("code=%d output=%q", code, output.String())
	}
	archive, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(body), "private-token") {
			t.Fatal("command exported a token")
		}
	}
	if _, err := os.Stat(filepath.Join(home, "data", "engine.json")); !os.IsNotExist(err) {
		t.Fatal("diagnose started an engine")
	}
}
