package websocket_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/websocket"
)

func TestBinaryOutputAndTextControlRemainDistinct(t *testing.T) {
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		binary, body, err := conn.ReadMessage()
		if err != nil || binary || string(body) != "input" {
			return
		}
		_ = conn.WriteBinary([]byte{0xff, 0x00, 0x1b})
		_ = conn.Write([]byte(`{"cursor":3}`))
	}))
	defer host.Close()
	conn, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(host.URL, "http"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.Write([]byte("input")); err != nil {
		t.Fatal(err)
	}
	binary, body, err := conn.ReadMessage()
	if err != nil || !binary || !bytes.Equal(body, []byte{0xff, 0x00, 0x1b}) {
		t.Fatalf("binary=%v body=%v err=%v", binary, body, err)
	}
	binary, body, err = conn.ReadMessage()
	if err != nil || binary || string(body) != `{"cursor":3}` {
		t.Fatalf("control=%q err=%v", body, err)
	}
}
