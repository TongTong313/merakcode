package sandbox_test

import (
	"os"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
)

func TestPrivateDirectoryRequiresAStateDirectory(t *testing.T) {
	temporary := t.TempDir()
	for _, name := range []string{"TMP", "TEMP", "TMPDIR"} {
		t.Setenv(name, temporary)
	}
	launcher := new(sandbox.Launcher)
	defer launcher.Close()
	command, err := launcher.Command(t.Context(), sandbox.Profile{}, os.Args[0])
	if command != nil || err == nil || !strings.Contains(err.Error(), "sandbox state directory is required") {
		t.Fatalf("an omitted state directory was accepted: command=%v error=%v", command != nil, err)
	}
	if entries, err := os.ReadDir(temporary); err != nil || len(entries) != 0 {
		t.Fatalf("the system temporary directory changed: entries=%v error=%v", entries, err)
	}
}
