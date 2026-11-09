//go:build sandbox_integration && sandbox_external

package sandbox_test

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestSandboxExternalNetwork(t *testing.T) {
	target, err := url.Parse(os.Getenv("MERAKCODE_SANDBOX_EXTERNAL_TARGET"))
	if err != nil || target == nil || target.Scheme != "http" || target.Hostname() == "" || target.User != nil {
		t.Fatal("MERAKCODE_SANDBOX_EXTERNAL_TARGET must name an external http://host:port control endpoint")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(t.Context(), target.Hostname())
	if err != nil || len(addresses) == 0 {
		t.Fatalf("resolve external host=%s: %v", target.Hostname(), err)
	}
	for _, address := range addresses {
		if address.IP.IsLoopback() || address.IP.IsUnspecified() || address.IP.IsPrivate() || address.IP.IsLinkLocalUnicast() {
			t.Fatalf("control host=%s is not external: %s", target.Hostname(), address.IP)
		}
	}
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	response, err := client.Get(target.String())
	if err != nil {
		t.Fatalf("unrestricted control host=%s: %v", target.Host, err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("control host=%s status=%d, expected 200", target.Host, response.StatusCode)
	}
	workspace := t.TempDir()
	for _, test := range []struct {
		name, operation           string
		allowed, denied, succeeds bool
	}{
		{"unlisted proxy target", "fetch-proxy", false, false, false},
		{"listed proxy target", "fetch-proxy", true, false, true},
		{"deny overrides allow", "fetch-proxy", true, true, false},
		{"direct proxy bypass", "fetch", true, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			l := consistencyLauncher(t)
			p := sandbox.Profile{WriteAllow: []string{workspace}, EnvAllow: []string{"SystemRoot"}, Network: sandbox.Network{Mode: "allowlist"}}
			if test.allowed {
				p.Network.Hosts = []string{target.Host}
			}
			if test.denied {
				p.Network.Deny = []string{target.Host}
			}
			status := l.Status(t.Context(), p)
			if status.Network == "none" {
				t.Fatalf("external host=%s has no network enforcement: %+v", target.Host, status)
			}
			output, err := consistencyCommand(t, l, p, workspace, os.Args[0], "-test.run=^TestSandboxChild$", "--", test.operation, target.String())
			if (err == nil) != test.succeeds {
				t.Fatalf("host=%s operation=%s expected success=%t status=%+v error=%v output=%s", target.Host, test.operation, test.succeeds, status, err, output)
			}
		})
	}
}
