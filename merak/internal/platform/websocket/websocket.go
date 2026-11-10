// Package websocket implements the bounded text transport used by the local JSON-RPC connection.
package websocket

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxMessage = 4 << 20

type Conn struct {
	net.Conn
	reader  *bufio.Reader
	client  bool
	writeMu sync.Mutex
}

func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func hasToken(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func Accept(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if r.Method != http.MethodGet || !hasToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Sec-WebSocket-Version") != "13" || err != nil || len(key) != 16 {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return nil, errors.New("websocket: invalid handshake")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("websocket: hijacking is unavailable")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	if _, err = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", acceptKey(r.Header.Get("Sec-WebSocket-Key"))); err == nil {
		err = rw.Flush()
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &Conn{Conn: conn, reader: rw.Reader}, nil
}

func Dial(ctx context.Context, endpoint, token string) (*Conn, error) {
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("websocket: invalid endpoint")
	}
	address := u.Host
	if u.Port() == "" {
		port := "80"
		if u.Scheme == "wss" {
			port = "443"
		}
		address = net.JoinHostPort(u.Hostname(), port)
	}
	var conn net.Conn
	if u.Scheme == "wss" {
		conn, err = (&tls.Dialer{Config: &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = (&net.Dialer{}).DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	u.Scheme = "http"
	req := &http.Request{Method: http.MethodGet, URL: u, Host: u.Host, Header: make(http.Header)}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	req.Header.Set("Authorization", "Bearer "+token)
	if err = req.Write(conn); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, req)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if response.StatusCode != 101 || !hasToken(response.Header.Get("Connection"), "upgrade") || !strings.EqualFold(response.Header.Get("Upgrade"), "websocket") || response.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		response.Body.Close()
		conn.Close()
		return nil, errors.New("websocket: handshake rejected")
	}
	return &Conn{Conn: conn, reader: reader, client: true}, nil
}

func (c *Conn) Read() ([]byte, error) {
	binary, body, err := c.ReadMessage()
	if err == nil && binary {
		return nil, errors.New("websocket: expected text")
	}
	return body, err
}

func (c *Conn) WriteBinary(body []byte) error { return c.writeFrame(2, body) }

func (c *Conn) ReadMessage() (bool, []byte, error) {
	binary := false
	var message []byte
	fragmented := false
	for {
		first, data, err := c.readFrame()
		if err != nil {
			return false, nil, err
		}
		opcode, final := first&15, first&0x80 != 0
		switch opcode {
		case 8:
			if len(data) == 1 || len(data) > 2 && !utf8.Valid(data[2:]) {
				return false, nil, errors.New("websocket: invalid close")
			}
			_ = c.writeFrame(8, data)
			return false, nil, io.EOF
		case 9:
			if err := c.writeFrame(10, data); err != nil {
				return false, nil, err
			}
			continue
		case 10:
			continue
		case 1, 2:
			if fragmented {
				return false, nil, errors.New("websocket: unexpected text frame")
			}
			binary = opcode == 2
			fragmented = !final
		case 0:
			if !fragmented {
				return false, nil, errors.New("websocket: unexpected continuation")
			}
		default:
			return false, nil, errors.New("websocket: unsupported opcode")
		}
		if len(message)+len(data) > maxMessage {
			return false, nil, errors.New("websocket: message is too large")
		}
		message = append(message, data...)
		if final {
			if !binary && !utf8.Valid(message) {
				return false, nil, errors.New("websocket: invalid text")
			}
			return binary, message, nil
		}
	}
}

func (c *Conn) readFrame() (byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return 0, nil, err
	}
	if header[0]&0x70 != 0 || (header[1]&0x80 != 0) == c.client {
		return 0, nil, errors.New("websocket: invalid frame")
	}
	length := uint64(header[1] & 0x7f)
	if header[0]&8 != 0 && (header[0]&0x80 == 0 || length > 125) {
		return 0, nil, errors.New("websocket: invalid control frame")
	}
	if length == 126 {
		var size [2]byte
		if _, err := io.ReadFull(c.reader, size[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(size[:]))
		if length < 126 {
			return 0, nil, errors.New("websocket: invalid length")
		}
	} else if length == 127 {
		var size [8]byte
		if _, err := io.ReadFull(c.reader, size[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(size[:])
		if length <= 65535 {
			return 0, nil, errors.New("websocket: invalid length")
		}
	}
	if length > maxMessage {
		return 0, nil, errors.New("websocket: message is too large")
	}
	var mask [4]byte
	if !c.client {
		if _, err := io.ReadFull(c.reader, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	data := make([]byte, int(length))
	if _, err := io.ReadFull(c.reader, data); err != nil {
		return 0, nil, err
	}
	if !c.client {
		for i := range data {
			data[i] ^= mask[i%4]
		}
	}
	return header[0], data, nil
}

func (c *Conn) Write(data []byte) error {
	return c.writeFrame(1, data)
}

func (c *Conn) writeFrame(opcode byte, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	defer c.SetWriteDeadline(time.Time{})
	if len(data) > maxMessage {
		return errors.New("websocket: message is too large")
	}
	header := []byte{0x80 | opcode}
	maskFlag := byte(0)
	if c.client {
		maskFlag = 0x80
	}
	switch {
	case len(data) < 126:
		header = append(header, maskFlag|byte(len(data)))
	case len(data) <= 65535:
		header = append(header, maskFlag|126)
		header = binary.BigEndian.AppendUint16(header, uint16(len(data)))
	default:
		header = append(header, maskFlag|127)
		header = binary.BigEndian.AppendUint64(header, uint64(len(data)))
	}
	if c.client {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		header = append(header, mask[:]...)
		masked := make([]byte, len(data))
		for i := range data {
			masked[i] = data[i] ^ mask[i%4]
		}
		data = masked
	}
	_, err := io.Copy(c.Conn, io.MultiReader(strings.NewReader(string(header)), strings.NewReader(string(data))))
	return err
}
