package sandbox

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

func proxyEnvironment(source []string, address string) []string {
	result := make([]string, 0, len(source)+6)
	for _, value := range source {
		name, _, _ := strings.Cut(value, "=")
		switch strings.ToUpper(name) {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
			continue
		}
		result = append(result, value)
	}
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		result = append(result, name+"="+address)
	}
	return result
}

func (l *Launcher) hostProxy(ctx context.Context, network Network) (string, func(), error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	proxy := &Proxy{Network: network, Approve: l.ApproveNetwork, Denied: l.NetworkDenied, MemberName: l.MemberName}
	secret := rand.Text()
	authorization := "Basic " + base64.StdEncoding.EncodeToString([]byte("merak:"+secret))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Proxy-Authorization")), []byte(authorization)) != 1 {
			w.Header().Set("Proxy-Authenticate", `Basic realm="MerakCode"`)
			http.Error(w, "proxy authentication required", http.StatusProxyAuthRequired)
			return
		}
		r.Header.Del("Proxy-Authorization")
		proxy.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	var once sync.Once
	close := func() { once.Do(func() { _ = server.Close(); proxy.Close() }) }
	stop := context.AfterFunc(ctx, close)
	go func() { _ = server.Serve(listener) }()
	address := &url.URL{Scheme: "http", Host: listener.Addr().String(), User: url.UserPassword("merak", secret)}
	return address.String(), func() { stop(); close() }, nil
}
