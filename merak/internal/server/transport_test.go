package server_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestFragmentedHelloAllowsInterleavedPing(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.New(e, "fixture-token")
	defer handler.Close()
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(httpServer.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer fixture-token\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", strings.TrimPrefix(httpServer.URL, "http://"))
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatalf("response=%v err=%v", response, err)
	}
	hello := `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":1,"client":{"name":"test","version":"1"}}}`
	for _, frame := range [][]byte{maskedFrame(0x01, []byte(hello[:25])), maskedFrame(0x89, []byte("ok")), maskedFrame(0x80, []byte(hello[25:]))} {
		if _, err := conn.Write(frame); err != nil {
			t.Fatal(err)
		}
	}
	var pong [4]byte
	if _, err := io.ReadFull(reader, pong[:]); err != nil {
		t.Fatal(err)
	}
	if string(pong[:]) != "\x8a\x02ok" {
		t.Fatalf("pong=%x", pong)
	}
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		t.Fatal(err)
	}
	if header[0] != 0x81 || header[1] >= 126 {
		t.Fatalf("header=%x", header)
	}
	body := make([]byte, int(header[1]))
	if _, err := io.ReadFull(reader, body); err != nil {
		t.Fatal(err)
	}
	var reply protocol.Message
	if err := json.Unmarshal(body, &reply); err != nil {
		t.Fatal(err)
	}
	var result protocol.HelloResult
	if err := json.Unmarshal(reply.Result, &result); err != nil || result.Protocol != 1 {
		t.Fatalf("reply=%s err=%v", body, err)
	}
}

func maskedFrame(first byte, payload []byte) []byte {
	frame := []byte{first, 0x80 | byte(len(payload)), 0x37, 0xfa, 0x21, 0x3d}
	for i, value := range payload {
		frame = append(frame, value^frame[2+i%4])
	}
	return frame
}
