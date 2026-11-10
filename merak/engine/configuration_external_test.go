package engine_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestIndependentHostCanImplementNetworkSettings(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	module, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Replace(string(module), "module github.com/TongTong313/merakcode/merak", "module example.test/host", 1)
	text += "\nrequire github.com/TongTong313/merakcode/merak v0.0.0\nreplace github.com/TongTong313/merakcode/merak => " + strconv.Quote(filepath.ToSlash(root)) + "\n"
	if err := os.WriteFile(filepath.Join(directory, "go.mod"), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	sums, err := os.ReadFile(filepath.Join(root, "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "go.sum"), sums, 0600); err != nil {
		t.Fatal(err)
	}
	source := `package host
import "github.com/TongTong313/merakcode/merak/engine"
type settings struct { engine.NetworkSettings }
func (settings) MCPServers() map[string]engine.MCPServer { return nil }
func (settings) RememberWorkspaceTrust(engine.WorkspaceTrust) error { return nil }
var _ engine.NetworkSettings = settings{}
`
	if err := os.WriteFile(filepath.Join(directory, "settings.go"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "go", "test", "-mod=readonly", ".")
	command.Dir = directory
	command.Env = append(os.Environ(), "GOWORK=off", "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("independent host cannot implement the public contract: %v\n%s", err, output)
	}
}
