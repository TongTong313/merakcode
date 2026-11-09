package claudecode_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestCatalogFindsAProductOnPath(t *testing.T) {
	binary := fakeBinary(t)
	t.Setenv("PATH", filepath.Dir(binary))
	for _, product := range worker.Catalog(context.Background()) {
		if product.Kind != worker.KindClaudeCode {
			continue
		}
		if !product.Available || product.Binary != binary || !product.Caps.Steer || !product.Caps.Permission || product.Version != "2.1.0 (Claude Code fixture)" {
			t.Fatalf("product=%+v", product)
		}
		return
	}
	t.Fatal("Claude Code was missing from the catalog")
}

func TestCatalogAllowsAProductToFinishColdStartup(t *testing.T) {
	t.Setenv("MERAKCODE_FIXTURE_SLOW_VERSION", "1")
	TestCatalogFindsAProductOnPath(t)
}
