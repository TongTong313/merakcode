package worker_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCatalogDiscoversAllSupportedLocalProducts(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "fixture.exe")
	build := process.Command(context.Background(), "", "go", "build", "-o", binary, "./command/testdata/fakecommand")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	body, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "codex", "opencode", "pi"} {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err := os.WriteFile(filepath.Join(dir, name), body, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	products := map[worker.Kind]worker.ProductInfo{}
	for _, product := range worker.Catalog(context.Background()) {
		products[product.Kind] = product
	}
	for _, kind := range []worker.Kind{"claude-code", "codex", "opencode", "pi"} {
		product, ok := products[kind]
		if !ok || !product.Available || product.Version != "fixture 1.0.0" {
			t.Errorf("product %s=%+v", kind, product)
		}
	}
	if !products["builtin"].Caps.Permission || !products["codex"].Caps.Permission || !products["opencode"].Caps.Permission || products["pi"].Caps.Permission {
		t.Errorf("capabilities=%+v", products)
	}
}
