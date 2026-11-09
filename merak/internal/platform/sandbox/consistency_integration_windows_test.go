//go:build sandbox_integration

package sandbox_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Fixture homes need the same read grant as the real user home during setup.
func prepareConsistencyHome(t *testing.T, home string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(os.Getenv("MERAKCODE_SANDBOX_TEST_STATE"), "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct{ Group struct{ SID string } }
	if err := json.Unmarshal(bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf}), &manifest); err != nil || manifest.Group.SID == "" {
		t.Fatalf("test group identity: %v", err)
	}
	if out, err := exec.Command("icacls", home, "/grant", "*"+manifest.Group.SID+":(OI)(CI)RX").CombinedOutput(); err != nil {
		t.Fatalf("fixture home read grant: path=%s error=%v output=%s", home, err, out)
	}
}
