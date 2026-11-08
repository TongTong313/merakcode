package terminal_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
)

func TestTerminalReplaysToIndependentSubscribersAndRemovesProject(t *testing.T) {
	bus := event.NewBus(nil, time.Now, event.NewID)
	facts, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	manager := terminal.New(bus, event.NewID)
	defer manager.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	command, args := "/bin/sh", []string{}
	if runtime.GOOS == "windows" {
		command, args = os.Getenv("COMSPEC"), []string{"/Q"}
	}
	info, err := manager.Create(ctx, terminal.CreateOptions{Directory: directory, Command: command, Args: args, Title: "First", Size: terminal.Size{Cols: 80, Rows: 24}})
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if err := manager.Write(info.ID, []byte("echo SHARED-OUTPUT\r\n")); err != nil {
		t.Fatal(err)
	}
	for _, subscriber := range []*terminal.Subscription{first, second} {
		var result strings.Builder
		for !strings.Contains(result.String(), "SHARED-OUTPUT") {
			chunk, err := subscriber.Next(ctx)
			if err != nil {
				t.Fatal(err)
			}
			result.Write(chunk.Data)
		}
	}
	first.Close()
	replay, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Close()
	chunk, err := replay.Next(ctx)
	if err != nil || !strings.Contains(string(chunk.Data), "SHARED-OUTPUT") {
		t.Fatalf("replay=%q err=%v", chunk.Data, err)
	}
	if _, err := manager.Update(ctx, info.ID, terminal.UpdateOptions{Title: ptr("Renamed"), Size: &terminal.Size{Cols: 100, Rows: 40}}); err != nil {
		t.Fatal(err)
	}
	if got, err := manager.Get(info.ID); err != nil || got.Title != "Renamed" || got.Size.Cols != 100 {
		t.Fatalf("info=%+v err=%v", got, err)
	}
	if err := manager.CloseProject(ctx, directory); err != nil {
		t.Fatal(err)
	}
	if len(manager.List(directory)) != 0 {
		t.Fatal("project terminal survived")
	}
	kinds := map[event.Type]bool{}
	for len(facts) > 0 {
		kinds[(<-facts).Type] = true
	}
	for _, kind := range []event.Type{terminal.Created, terminal.Updated, terminal.Exited, terminal.Deleted} {
		if !kinds[kind] {
			t.Fatalf("missing %s", kind)
		}
	}
}
func ptr(s string) *string { return &s }

func TestTerminalPreservesFinalOutputAfterRequestCancellation(t *testing.T) {
	manager := terminal.New(event.NewBus(nil, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	for attempt := 0; attempt < 5; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		command, args := "/bin/sh", []string{"-c", "printf LAST-FRAME"}
		if runtime.GOOS == "windows" {
			command, args = os.Getenv("COMSPEC"), []string{"/C", "echo LAST-FRAME"}
		}
		info, err := manager.Create(ctx, terminal.CreateOptions{Directory: t.TempDir(), Command: command, Args: args})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			current, _ := manager.Get(info.ID)
			if current.Status == "exited" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("terminal did not exit")
			}
			time.Sleep(10 * time.Millisecond)
		}
		subscriber, err := manager.Subscribe(info.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		chunk, err := subscriber.Next(context.Background())
		subscriber.Close()
		if err != nil || !strings.Contains(string(chunk.Data), "LAST-FRAME") {
			t.Fatalf("last output=%q err=%v", chunk.Data, err)
		}
	}
}

func TestTerminalDefaultShellAndEnvironment(t *testing.T) {
	t.Setenv("MERAKCODE_ENGINE_TOKEN", "fixture-secret")
	t.Setenv("MERAKCODE_TERMINAL", "wrong")
	t.Setenv("TERM", "wrong")
	t.Setenv("MERAKCODE_PTY_HOST_TEST", "")
	if runtime.GOOS != "windows" {
		t.Setenv("SHELL", "/bin/sh")
	}
	manager := terminal.New(event.NewBus(nil, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	info, err := manager.Create(context.Background(), terminal.CreateOptions{Directory: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Args) == 0 || info.Args[0] != "-l" {
		t.Fatalf("login shell args=%v", info.Args)
	}
	subscriber, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer subscriber.Close()
	command := "printf 'ENV:%s:%s:%s\\n' \"$TERM\" \"$MERAKCODE_TERMINAL\" \"${MERAKCODE_ENGINE_TOKEN-unset}\"\n"
	if err := manager.Write(info.ID, []byte(command)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var output strings.Builder
	for !strings.Contains(output.String(), "ENV:xterm-256color:1:unset") {
		chunk, err := subscriber.Next(ctx)
		if err != nil {
			t.Fatalf("environment was not set: %v", err)
		}
		output.Write(chunk.Data)
	}
}

func TestTerminalLargeOutputFixture(t *testing.T) {
	if os.Getenv("MERAKCODE_TERMINAL_OUTPUT_FIXTURE") != "1" {
		return
	}
	chunk := strings.Repeat("0123456789abcdef", 512) + "\r\n"
	for index := 0; index < 1000; index++ {
		fmt.Print(chunk)
		time.Sleep(2 * time.Millisecond)
	}
	fmt.Print("FINAL-LARGE-OUTPUT\r\n")
}

func TestTerminalReplayKeepsOnlyLastTwoMiB(t *testing.T) {
	t.Setenv("MERAKCODE_TERMINAL_OUTPUT_FIXTURE", "1")
	manager := terminal.New(event.NewBus(nil, time.Now, event.NewID), event.NewID)
	defer manager.Close()
	info, err := manager.Create(context.Background(), terminal.CreateOptions{Directory: t.TempDir(), Command: os.Args[0], Args: []string{"-test.run=^TestTerminalLargeOutputFixture$"}, Size: terminal.Size{Cols: 200, Rows: 100}})
	if err != nil {
		t.Fatal(err)
	}
	subscriber, err := manager.Subscribe(info.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer subscriber.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var received []byte
	var cursor uint64
	for {
		chunk, err := subscriber.Next(ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		received = append(received, chunk.Data...)
		cursor = chunk.Cursor
	}
	if len(received) <= 2<<20 {
		t.Fatalf("insufficient actual PTY output: %d bytes", len(received))
	}
	if !strings.Contains(string(received), "FINAL-LARGE-OUTPUT") {
		t.Fatal("lost the final output frame")
	}
	for _, position := range []uint64{0, cursor - 17} {
		replay, err := manager.Subscribe(info.ID, position)
		if err != nil {
			t.Fatal(err)
		}
		chunk, err := replay.Next(ctx)
		replay.Close()
		if err != nil {
			t.Fatal(err)
		}
		count := min(int(cursor-position), 2<<20)
		if chunk.Cursor != cursor || !bytes.Equal(chunk.Data, received[len(received)-count:]) {
			t.Fatalf("replay length=%d cursor=%d want length=%d cursor=%d", len(chunk.Data), chunk.Cursor, count, cursor)
		}
	}
}
