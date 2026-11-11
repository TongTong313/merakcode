package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/server"
)

func TestMain(m *testing.M) {
	if os.Getenv("MERAKCODE_CLI_TEST_CHILD") == "1" {
		os.Exit(Run(os.Args[1:], os.Stdin, os.Stdout))
	}
	if err := os.Setenv("MERAKCODE_CLI_TEST_CHILD", "1"); err != nil {
		panic(err)
	}
	// no test may write to the system vault of the machine
	if err := os.Setenv("MERAKCODE_FILE_CREDENTIALS", "1"); err != nil {
		panic(err)
	}
	// no test may reach the public model catalog on the internet
	if err := os.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "1"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func cleanupEngine(t *testing.T, home string) {
	t.Helper()
	t.Cleanup(func() {
		info, err := server.ReadInfo(filepath.Join(home, "data"))
		if err != nil {
			return
		}
		if info.PID == os.Getpid() {
			return
		}
		process, err := os.FindProcess(info.PID)
		if err != nil {
			return
		}
		_ = process.Kill()
		_, _ = process.Wait()
	})
}

// startAt hosts an engine the way merak serve does: connection file in <home>/data, configuration in <home>.
func startAt(e *engine.Engine, home string) (*server.Instance, error) {
	return server.StartWith(e, server.Options{Data: filepath.Join(home, "data"), Config: home, Address: "127.0.0.1"})
}
