package cli

import (
	"os"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/server"
)

func TestMain(m *testing.M) {
	if os.Getenv("MERAKCODE_CLI_TEST_CHILD") == "1" {
		os.Exit(Run(os.Args[1:], os.Stdin, os.Stdout))
	}
	if err := os.Setenv("MERAKCODE_CLI_TEST_CHILD", "1"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

func cleanupEngine(t *testing.T, home string) {
	t.Helper()
	t.Cleanup(func() {
		info, err := server.ReadInfo(home)
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
