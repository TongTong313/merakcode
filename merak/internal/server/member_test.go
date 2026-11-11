package server_test

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestMemberCatalogFindsAProductOnPATH(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(dir, name)
	cmd := process.Command(ctx, "", "go", "build", "-o", binary, "../../engine/worker/claudecode/testdata/fakeclaude")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var products []worker.ProductInfo
	if err := client.Call(ctx, "member.catalog", struct{}{}, &products); err != nil {
		t.Fatal(err)
	}
	for _, product := range products {
		if product.Kind != worker.KindClaudeCode {
			continue
		}
		if !product.Available || product.Binary != binary || product.Version != "2.1.0 (Claude Code fixture)" || !product.Caps.Steer {
			t.Fatalf("product=%+v", product)
		}
		return
	}
	t.Fatal("Claude Code is missing from the catalog")
}

func TestMemberProbeChecksTheProtocolInAnIsolatedDirectory(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	dir := t.TempDir()
	binary := filepath.Join(dir, "fakeclaude")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	cmd := process.Command(ctx, "", "go", "build", "-o", binary, "../../engine/worker/claudecode/testdata/fakeclaude")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, output)
	}
	e, err := engine.New(engine.Deps{Workdir: dir})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	p := profile.DefaultWorker()
	p.Product = &profile.Product{Kind: worker.KindClaudeCode, Binary: binary}
	var caps worker.Caps
	if err := client.Call(ctx, "member.test", map[string]any{"profile": p}, &caps); err != nil {
		t.Fatal(err)
	}
	if !caps.Steer {
		t.Fatalf("caps=%+v", caps)
	}
	for _, name := range []string{"system.txt", "tools.txt", "inputs.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("probe touched the project: %s %v", name, err)
		}
	}
	invalid := filepath.Join(dir, "invalid.jsonl")
	if err := os.WriteFile(invalid, []byte("not JSON\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p.Product.Args = []string{"--fixture", invalid}
	if err := client.Call(ctx, "member.test", map[string]any{"profile": p}, &caps); err == nil {
		t.Fatal("invalid protocol was reported as connected")
	}
}
