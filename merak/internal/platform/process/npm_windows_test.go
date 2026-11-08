package process_test

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNpmShimPreservesArgumentsWithoutShellExpansion(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "program.js")
	if err := os.WriteFile(script, []byte(`process.stdout.write(JSON.stringify(process.argv.slice(2)))`), 0600); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "program.cmd")
	body := "@ECHO off\r\nSET dp0=%~dp0\r\nSET \"_prog=node\"\r\n\"%_prog%\" \"%dp0%\\program.js\" %*\r\n"
	if err := os.WriteFile(shim, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"space inside", "quoted\"value", "%PATH%", "x&echo altered", "line\nbreak", "末尾\\"}
	cmd := process.Command(context.Background(), dir, shim, args...)
	bodyBytes, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := json.Unmarshal(bodyBytes, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("args=%q", got)
	}
}
