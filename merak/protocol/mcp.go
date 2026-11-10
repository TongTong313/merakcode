package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// ConnectMCP connects a product to the tools granted to one external member run.
// The member token and scope are independent of the engine protocol connection.
func ConnectMCP(ctx context.Context, address, token, role, scope string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return nil, errors.New("MCP endpoint must use loopback")
	}
	connection, err := dialMemberEndpoint(ctx, address)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if err := json.NewEncoder(connection).Encode(struct{ Token, Role, Scope string }{Token: token, Role: role, Scope: scope}); err != nil {
		connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	line, err := reader.ReadString('\n')
	if err != nil || line != "ok\n" {
		connection.Close()
		return nil, errors.New("MCP endpoint rejected this member")
	}
	_ = connection.SetDeadline(time.Time{})
	return mcpConnection{Conn: connection, reader: reader}, nil
}

func dialMemberEndpoint(ctx context.Context, address string) (net.Conn, error) {
	proxy := os.Getenv("MERAKCODE_SANDBOX_PROXY")
	if proxy == "" {
		return (&net.Dialer{}).DialContext(ctx, "tcp", address)
	}
	target, err := url.Parse(proxy)
	if err != nil || target.Scheme != "http" || net.ParseIP(target.Hostname()) == nil || !net.ParseIP(target.Hostname()).IsLoopback() {
		return nil, errors.New("invalid sandbox proxy")
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", target.Host)
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Host: address}, Host: address, Header: make(http.Header)}
	if target.User != nil {
		password, _ := target.User.Password()
		request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(target.User.Username()+":"+password)))
	}
	if err := request.Write(connection); err != nil {
		connection.Close()
		return nil, err
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, request)
	if err != nil || response.StatusCode != http.StatusOK {
		connection.Close()
		return nil, errors.New("sandbox proxy rejected MCP endpoint")
	}
	_ = connection.SetDeadline(time.Time{})
	return mcpConnection{Conn: connection, reader: reader}, nil
}

type mcpConnection struct {
	net.Conn
	reader *bufio.Reader
}

func (c mcpConnection) Read(p []byte) (int, error) { return c.reader.Read(p) }
