package pty_test

import (
	"context"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"io"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/pty"
)

func shell(t *testing.T) *pty.Process {
	t.Helper()
	command, args := "/bin/sh", []string{}
	if runtime.GOOS == "windows" {
		command, args = os.Getenv("COMSPEC"), []string{"/Q"}
	}
	p, err := pty.Start(pty.Options{Command: command, Args: args, Directory: t.TempDir(), Env: append(os.Environ(), "MERAKCODE_PTY_TEST=READY"), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	return p
}

func TestInteractiveShellEchoAndResize(t *testing.T) {
	p := shell(t)
	output := make(chan string, 1)
	go func() {
		var text strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := p.Read(buf)
			text.Write(buf[:n])
			if strings.Contains(text.String(), "PTY-READY") {
				output <- text.String()
				return
			}
			if err != nil {
				output <- text.String()
				return
			}
		}
	}()
	if err := p.Resize(100, 40); err != nil {
		t.Fatal(err)
	}
	command := "echo PTY-$MERAKCODE_PTY_TEST\n"
	if runtime.GOOS == "windows" {
		command = "echo PTY-%MERAKCODE_PTY_TEST%\r\n"
	}
	if _, err := p.Write([]byte(command)); err != nil {
		t.Fatal(err)
	}
	select {
	case text := <-output:
		if !strings.Contains(text, "PTY-READY") {
			t.Fatalf("output=%q", text)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no shell echo")
	}
}

func TestShellTeardownIsIdempotent(t *testing.T) {
	for _, name := range []string{"natural exit", "immediate input and close", "output pipe closed"} {
		t.Run(name, func(t *testing.T) {
			p := shell(t)
			if name == "natural exit" {
				go io.Copy(io.Discard, p)
				_, _ = p.Write([]byte("exit\r\n"))
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if _, err := p.Wait(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				_, _ = p.Write([]byte("echo EARLY\r\n"))
				if name == "output pipe closed" {
					if err := p.CloseOutput(); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := p.Close(); err != nil {
				t.Fatal(err)
			}
			if err := p.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := p.Write([]byte("late")); err != nil {
				t.Fatal(err)
			}
			if err := p.Resize(80, 24); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, err := p.Wait(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHostExitsAfterItsTerminalChildExits(t *testing.T) {
	if os.Getenv("MERAKCODE_PTY_HOST_TEST") == "1" {
		command, args := "/bin/sh", []string{"-c", "exit 0"}
		if runtime.GOOS == "windows" {
			command, args = os.Getenv("COMSPEC"), []string{"/C", "exit 0"}
		}
		p, err := pty.Start(pty.Options{Command: command, Args: args, Directory: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		go io.Copy(io.Discard, p)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := p.Wait(ctx); err != nil {
			t.Fatal(err)
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := process.Command(ctx, t.TempDir(), os.Args[0], "-test.run=^TestHostExitsAfterItsTerminalChildExits$")
	command.Env = append(os.Environ(), "MERAKCODE_PTY_HOST_TEST=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("host: %v\n%s", err, output)
	}
}
