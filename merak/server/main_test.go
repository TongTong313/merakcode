package server_test

import (
	"os"
	"testing"

	"github.com/TongTong313/merakcode/merak/testkit/testmodel"
)

// The tests that need the background refresh of the model lists turn it on themselves; no other test may reach the
// public catalog on the internet.
func TestMain(m *testing.M) {
	testmodel.Isolate()
	os.Setenv("MERAKCODE_DISABLE_CATALOG_FETCH", "1")
	os.Exit(m.Run())
}
