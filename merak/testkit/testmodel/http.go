// Package testmodel isolates HTTP requests made by model and engine tests.
package testmodel

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Isolate removes inherited provider settings and rejects non-loopback HTTP
// destinations before resolution or dialing. A test may set its own local fixtures.
func Isolate() {
	for _, setting := range os.Environ() {
		name, _, _ := strings.Cut(setting, "=")
		upper := strings.ToUpper(name)
		if strings.HasSuffix(upper, "_API_KEY") || strings.HasSuffix(upper, "_BASE_URL") ||
			strings.HasPrefix(upper, "DASHSCOPE_") || strings.HasPrefix(upper, "ALIBABA_CLOUD_") ||
			strings.HasPrefix(upper, "OPENAI_") || strings.HasPrefix(upper, "ANTHROPIC_") {
			if err := os.Unsetenv(name); err != nil {
				panic(err)
			}
		}
	}
	RestrictHTTP()
}

// RestrictHTTP keeps a child test process on loopback while preserving fixture
// settings supplied by its already isolated parent.
func RestrictHTTP() {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = localOnly
	http.DefaultTransport = transport
}

func localOnly(request *http.Request) (*url.URL, error) {
	if !net.ParseIP(request.URL.Hostname()).IsLoopback() {
		return nil, errors.New("model tests require a numeric loopback address")
	}
	return nil, nil
}
