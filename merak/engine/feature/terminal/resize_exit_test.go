package terminal_test

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/feature/terminal"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func TestTerminalExitPreservesOutputWhileItsSizeIsUpdated(t *testing.T) {
	t.Setenv("MERAKCODE_TERMINAL_OUTPUT_FIXTURE", "1")
	bus := event.NewBus(nil, time.Now, event.NewID)
	facts, unsubscribe := bus.Subscribe(event.Filter{Types: []event.Type{terminal.Exited}})
	defer unsubscribe()
	manager := terminal.New(bus, event.NewID)
	defer manager.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	info, err := manager.Create(ctx, terminal.CreateOptions{
		Directory: t.TempDir(), Command: os.Args[0],
		Args: []string{"-test.run=^TestTerminalLargeOutputFixture$"},
		Size: terminal.Size{Cols: 200, Rows: 100},
	})
	if err != nil {
		t.Fatal(err)
	}
	output, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	var received strings.Builder
	updates := 0
	for {
		chunk, err := output.Next(ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		received.Write(chunk.Data)
		_, err = manager.Update(ctx, info.ID, terminal.UpdateOptions{Size: &terminal.Size{Cols: 200 + updates%2, Rows: 100}})
		if err != nil {
			t.Fatal(err)
		}
		updates++
	}
	if updates == 0 || !strings.Contains(received.String(), "FINAL-LARGE-OUTPUT") {
		t.Fatalf("updates=%d; final terminal output missing", updates)
	}
	select {
	case fact := <-facts:
		ended, err := event.Decode[terminal.Info](fact)
		if err != nil || ended.ID != info.ID || ended.Status != "exited" || ended.ExitCode == nil || *ended.ExitCode != 0 {
			t.Fatalf("exit event=%+v, error=%v", ended, err)
		}
	case <-ctx.Done():
		t.Fatal("terminal exit event missing")
	}
}
