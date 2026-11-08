package sandbox_test

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestClosingProxyCancelsAnUnansweredDNSRequest(t *testing.T) {
	dns, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer dns.Close()
	queried := make(chan struct{})
	go func() {
		_, _, err := dns.ReadFrom(make([]byte, 4096))
		if err == nil {
			close(queried)
		}
	}()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, dns.LocalAddr().String())
	}}
	defer func() { net.DefaultResolver = previous }()
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"allowed.example"}}}
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: http.ProxyURL(address)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	done := make(chan error, 1)
	go func() {
		response, err := client.Get("http://allowed.example/")
		if response != nil {
			_ = response.Body.Close()
		}
		done <- err
	}()
	select {
	case <-queried:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not query the isolated DNS server")
	}
	proxy.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy kept waiting for DNS after Close")
	}
}

func TestTunnelPreservesTheResponseAfterClientFinishesWriting(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	served := make(chan error, 1)
	go func() {
		connection, err := target.Accept()
		if err != nil {
			served <- err
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
		body, err := io.ReadAll(connection)
		if err == nil {
			_, err = io.WriteString(connection, "received:"+string(body))
		}
		served <- err
	}()
	port := target.Addr().(*net.TCPAddr).Port
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "off", LocalPorts: []int{port}}}
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", address.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(connection, "CONNECT "+target.Addr().String()+" HTTP/1.1\r\nHost: "+target.Addr().String()+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT response = %v, %v", response, err)
	}
	if _, err := io.WriteString(connection, "complete input"); err != nil {
		t.Fatal(err)
	}
	if err := connection.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	if err != nil || string(body) != "received:complete input" {
		t.Fatalf("response after input EOF = %q, %v", body, err)
	}
	if err := <-served; err != nil {
		t.Fatal(err)
	}
}

func TestClosingProxyClosesAnActiveTunnelAndRejectsNewRequests(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	port := target.Addr().(*net.TCPAddr).Port
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "off", LocalPorts: []int{port}}}
	server := httptest.NewServer(proxy)
	defer server.Close()
	defer proxy.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := net.DialTimeout("tcp", address.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(client, "CONNECT "+target.Addr().String()+" HTTP/1.1\r\nHost: "+target.Addr().String()+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(client), &http.Request{Method: http.MethodConnect})
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT response = %v, %v", response, err)
	}
	upstream, err := target.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	proxy.Close()
	for _, connection := range []net.Conn{client, upstream} {
		if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		_, err := connection.Read(make([]byte, 1))
		if err != io.EOF {
			t.Fatalf("closed tunnel read = %v", err)
		}
	}
	response, err = http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("closed proxy status = %d", response.StatusCode)
	}
}

func TestProxyTunnelsTLSOnlyToTheAllowedPort(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "encrypted response")
	}))
	defer target.Close()
	destination, err := url.Parse(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(destination.Port())
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(&sandbox.Proxy{Network: sandbox.Network{Mode: "off", LocalPorts: []int{port}}})
	defer server.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(target.Certificate())
	transport := &http.Transport{Proxy: http.ProxyURL(address), TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport}).Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK || string(body) != "encrypted response" {
		t.Fatalf("TLS response = %d, %q, %v", response.StatusCode, body, err)
	}
}

func TestNetworkOffRejectsARealProxyRequest(t *testing.T) {
	var requests atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = io.WriteString(w, "unexpected")
	}))
	defer target.Close()
	proxy := &sandbox.Proxy{Network: sandbox.Network{Mode: "off"}}
	server := httptest.NewServer(proxy)
	defer server.Close()
	address, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: http.ProxyURL(address)}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	response, err := client.Get(target.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden || requests.Load() != 0 {
		t.Fatalf("response = %d, upstream requests = %d", response.StatusCode, requests.Load())
	}
}

func TestProxyAllowsOnlyTheExplicitLocalPort(t *testing.T) {
	for _, test := range []struct {
		name    string
		blocked bool
		want    int
	}{
		{"permits the allowed local port", false, http.StatusOK},
		{"blocked ports override local permission", true, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Proxy-Authorization") != "" {
					t.Error("proxy credentials reached the destination")
				}
				_, _ = io.WriteString(w, "allowed response")
			}))
			defer target.Close()
			destination, err := url.Parse(target.URL)
			if err != nil {
				t.Fatal(err)
			}
			port, err := strconv.Atoi(destination.Port())
			if err != nil {
				t.Fatal(err)
			}
			policy := sandbox.Network{Mode: "off", LocalPorts: []int{port}}
			if test.blocked {
				policy.BlockedPorts = []int{port}
			}
			server := httptest.NewServer(&sandbox.Proxy{Network: policy})
			defer server.Close()
			address, err := url.Parse(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			transport := &http.Transport{Proxy: http.ProxyURL(address)}
			defer transport.CloseIdleConnections()
			request, err := http.NewRequest(http.MethodGet, target.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Proxy-Authorization", "test proxy credential")
			response, err := (&http.Client{Transport: transport}).Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || response.StatusCode != test.want {
				t.Fatalf("response = %d, body %q, error %v", response.StatusCode, body, err)
			}
			if test.want == http.StatusOK && string(body) != "allowed response" {
				t.Fatalf("body = %q", body)
			}
		})
	}
}
