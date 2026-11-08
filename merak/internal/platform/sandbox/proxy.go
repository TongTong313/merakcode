package sandbox

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Network struct {
	Mode         string   `json:"mode"`
	Hosts        []string `json:"hosts,omitempty"`
	BlockedPorts []int    `json:"blockedPorts,omitempty"`
	LocalPorts   []int    `json:"localPorts,omitempty"`
}

var errNetworkDenied = errors.New("network destination denied")

// Proxy enforces the network destinations allowed by a process profile.
type Proxy struct {
	Network     Network
	mu          sync.Mutex
	closed      bool
	connections map[*proxyConnection]struct{}
	nextRequest uint64
	requests    map[uint64]context.CancelFunc
}

type proxyConnection struct {
	net.Conn
	proxy *Proxy
}

func (c *proxyConnection) Close() error {
	c.proxy.mu.Lock()
	delete(c.proxy.connections, c)
	c.proxy.mu.Unlock()
	return c.Conn.Close()
}

func (c *proxyConnection) CloseWrite() error {
	if writer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return writer.CloseWrite()
	}
	return c.Close()
}

func (p *Proxy) Close() {
	p.mu.Lock()
	p.closed = true
	cancels := make([]context.CancelFunc, 0, len(p.requests))
	for _, cancel := range p.requests {
		cancels = append(cancels, cancel)
	}
	connections := make([]*proxyConnection, 0, len(p.connections))
	for connection := range p.connections {
		connections = append(connections, connection)
	}
	p.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for _, connection := range connections {
		_ = connection.Close()
	}
}

func (p *Proxy) track(connection net.Conn) (net.Conn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		_ = connection.Close()
		return nil, net.ErrClosed
	}
	if p.connections == nil {
		p.connections = make(map[*proxyConnection]struct{})
	}
	tracked := &proxyConnection{Conn: connection, proxy: p}
	p.connections[tracked] = struct{}{}
	return tracked, nil
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		http.Error(w, "proxy is closed", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	p.nextRequest++
	id := p.nextRequest
	if p.requests == nil {
		p.requests = make(map[uint64]context.CancelFunc)
	}
	p.requests[id] = cancel
	p.mu.Unlock()
	defer func() {
		cancel()
		p.mu.Lock()
		delete(p.requests, id)
		p.mu.Unlock()
	}()
	r = r.WithContext(ctx)
	if r.Method == http.MethodConnect {
		p.tunnel(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" || r.URL.User != nil {
		http.Error(w, errNetworkDenied.Error(), http.StatusForbidden)
		return
	}
	request := r.Clone(r.Context())
	request.RequestURI = ""
	request.Host = request.URL.Host
	removeProxyHeaders(request.Header)
	transport := &http.Transport{DialContext: p.dial, DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second}
	defer transport.CloseIdleConnections()
	response, err := transport.RoundTrip(request)
	if err != nil {
		if errors.Is(err, errNetworkDenied) {
			http.Error(w, errNetworkDenied.Error(), http.StatusForbidden)
			return
		}
		http.Error(w, "proxy connection failed", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	removeProxyHeaders(response.Header)
	for key, values := range response.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func (p *Proxy) tunnel(w http.ResponseWriter, r *http.Request) {
	upstream, err := p.dial(r.Context(), "tcp", r.Host)
	if err != nil {
		http.Error(w, errNetworkDenied.Error(), http.StatusForbidden)
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "proxy tunnel unavailable", http.StatusBadGateway)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	client, err = p.track(client)
	if err != nil {
		return
	}
	defer client.Close()
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := buffered.Flush(); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		if _, err := io.Copy(upstream, buffered); err != nil {
			_ = upstream.Close()
			_ = client.Close()
		} else {
			_ = upstream.(*proxyConnection).CloseWrite()
		}
		close(done)
	}()
	if _, err := io.Copy(client, upstream); err != nil {
		_ = client.Close()
		_ = upstream.Close()
	} else {
		_ = client.(*proxyConnection).CloseWrite()
	}
	<-done
}

func (p *Proxy) dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errNetworkDenied
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 || slices.Contains(p.Network.BlockedPorts, port) {
		return nil, errNetworkDenied
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var addresses []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		addresses = []netip.Addr{ip}
	} else {
		local := normalizeHost(host) == "localhost" && slices.Contains(p.Network.LocalPorts, port)
		if !local && !p.Network.permitsHost(host) {
			return nil, errNetworkDenied
		}
		addresses, err = net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
	}
	var failure error = errNetworkDenied
	for _, ip := range addresses {
		if !p.Network.Allows(host, port, ip) {
			continue
		}
		connection, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), portText))
		if err != nil {
			failure = err
			continue
		}
		return p.track(connection)
	}
	return nil, failure
}

func removeProxyHeaders(header http.Header) {
	for _, connection := range header.Values("Connection") {
		for _, field := range strings.Split(connection, ",") {
			header.Del(strings.TrimSpace(field))
		}
	}
	for _, field := range []string{"Connection", "Proxy-Connection", "Proxy-Authenticate", "Proxy-Authorization", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
		header.Del(field)
	}
}
