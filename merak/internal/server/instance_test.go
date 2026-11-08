package server_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestInstancePublishesConnectionInfoAndExclusivelyOwnsItsDirectory(t *testing.T) {
	home := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	if _, err := os.Stat(filepath.Join(home, "engine.json")); err != nil {
		t.Fatalf("shared data layout: %v", err)
	}
	info, err := server.ReadInfo(home)
	if err != nil {
		t.Fatal(err)
	}
	if info.PID != os.Getpid() || len(info.Token) < 32 {
		t.Fatalf("invalid connection metadata")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, info.Endpoint, info.Token, protocol.HelloParams{Protocol: 1, Client: protocol.ClientInfo{Name: "test", Version: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	client.Close()
	other, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if duplicate, err := server.Start(other, home); err == nil {
		duplicate.Close()
		t.Fatal("two engines acquired one directory")
	}
	if err := instance.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := server.ReadInfo(home); !os.IsNotExist(err) {
		t.Fatalf("connection file remained after shutdown: %v", err)
	}
	next, err := server.Start(other, home)
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
}
