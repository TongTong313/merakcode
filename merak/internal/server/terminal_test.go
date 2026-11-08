package server_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestTerminalProtocolAndAuthenticatedByteChannel(t *testing.T) {
	e, err := engine.New(engine.Deps{})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	s := server.New(e, "token")
	defer s.Close()
	host := httptest.NewServer(s)
	defer host.Close()
	endpoint := "ws" + strings.TrimPrefix(host.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, endpoint, "token", protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	command, args := "/bin/sh", []string{}
	if runtime.GOOS == "windows" {
		command, args = os.Getenv("COMSPEC"), []string{"/Q"}
	}
	var created terminal.Info
	if err := client.Call(ctx, "terminal.create", terminal.CreateOptions{Directory: t.TempDir(), Command: command, Args: args}, &created); err != nil {
		t.Fatal(err)
	}
	url := endpoint + "/terminal/" + string(created.ID) + "?cursor=0"
	if unauthorized, err := websocket.Dial(ctx, url, "wrong"); err == nil {
		unauthorized.Close()
		t.Fatal("terminal accepted wrong token")
	}
	attached, err := websocket.Dial(ctx, url, "token")
	if err != nil {
		t.Fatal(err)
	}
	defer attached.Close()
	_ = attached.SetReadDeadline(time.Now().Add(10 * time.Second))
	if err := attached.Write([]byte("echo CHANNEL-OUTPUT\r\n")); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	var cursor uint64
	for !strings.Contains(output.String(), "CHANNEL-OUTPUT") || cursor == 0 {
		binary, body, err := attached.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if binary {
			output.Write(body)
			continue
		}
		var control struct {
			Cursor uint64 `json:"cursor"`
		}
		if err := json.Unmarshal(body, &control); err != nil {
			t.Fatal(err)
		}
		cursor = control.Cursor
	}
	for _, method := range []string{"terminal.list", "terminal.get", "terminal.update", "terminal.remove"} {
		t.Run(method, func(t *testing.T) {
			params := map[string]any{"id": created.ID}
			if method == "terminal.list" {
				params = map[string]any{"directory": created.Directory}
			}
			if method == "terminal.update" {
				params["title"] = "Renamed"
				params["size"] = terminal.Size{Cols: 100, Rows: 40}
			}
			var result any
			if err := client.Call(ctx, method, params, &result); err != nil {
				t.Fatal(err)
			}
			if method == "terminal.update" && result.(map[string]any)["title"] != "Renamed" {
				t.Fatalf("result=%v", result)
			}
		})
	}
	var remaining []terminal.Info
	if err := client.Call(ctx, "terminal.list", map[string]any{}, &remaining); err != nil || len(remaining) != 0 {
		t.Fatalf("remaining=%v err=%v", remaining, err)
	}
}
