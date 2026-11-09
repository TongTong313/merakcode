package sandbox_test

import (
	"net/netip"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestNetworkPolicyChecksTheHostResolvedAddressAndPortTogether(t *testing.T) {
	for _, test := range []struct {
		name    string
		policy  sandbox.Network
		host    string
		address string
		port    int
		want    bool
	}{
		{"off denies remote addresses", sandbox.Network{Mode: "off"}, "example.com", "8.8.8.8", 443, false},
		{"on permits remote addresses", sandbox.Network{Mode: "on"}, "example.com", "8.8.8.8", 443, true},
		{"allowlist permits an exact host", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "EXAMPLE.COM.", "8.8.8.8", 443, true},
		{"allowlist rejects a suffix attack", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "example.com.attacker.test", "8.8.8.8", 443, false},
		{"allowlist rejects an unlisted subdomain", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "sub.example.com", "8.8.8.8", 443, false},
		{"blocked ports override on", sandbox.Network{Mode: "on", BlockedPorts: []int{443}}, "example.com", "8.8.8.8", 443, false},
		{"on does not expose local services", sandbox.Network{Mode: "on"}, "localhost", "127.0.0.1", 1234, false},
		{"allowed hosts cannot rebind to local services", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "example.com", "127.0.0.1", 1234, false},
		{"off permits an explicit local port", sandbox.Network{Mode: "off", LocalPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, true},
		{"blocked ports override local ports", sandbox.Network{Mode: "off", LocalPorts: []int{1234}, BlockedPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, false},
		{"mapped IPv4 still needs local permission", sandbox.Network{Mode: "on"}, "localhost", "::ffff:127.0.0.1", 1234, false},
		{"rejects unknown modes", sandbox.Network{Mode: "invalid", LocalPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, false},
		{"rejects an unspecified address", sandbox.Network{Mode: "on"}, "0.0.0.0", "0.0.0.0", 443, false},
		{"rejects multicast", sandbox.Network{Mode: "on"}, "224.0.0.1", "224.0.0.1", 443, false},
		{"rejects a zero port", sandbox.Network{Mode: "on"}, "example.com", "8.8.8.8", 0, false},
		{"rejects an oversized port", sandbox.Network{Mode: "on"}, "example.com", "8.8.8.8", 65536, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			address := netip.MustParseAddr(test.address)
			if got := test.policy.Allows(test.host, test.port, address); got != test.want {
				t.Fatalf("allowed = %t, want %t", got, test.want)
			}
		})
	}
}

func TestNetworkRulesMatchSubdomainsAndOptionalPorts(t *testing.T) {
	for _, test := range []struct {
		name, rule, host string
		port             int
		want             bool
	}{
		{"subdomain", "*.example.com", "api.example.com", 443, true},
		{"nested subdomain", "*.example.com", "edge.api.example.com", 443, true},
		{"case and trailing dot", "*.EXAMPLE.com.", "API.example.COM.", 443, true},
		{"apex", "*.example.com", "example.com", 443, false},
		{"suffix attack", "*.example.com", "example.com.attacker.test", 443, false},
		{"literal address", "*.example.com", "8.8.8.8", 443, false},
		{"wildcard numeric suffix", "*.8.8.8", "8.8.8.8", 443, false},
		{"exact port", "example.com:8443", "example.com", 8443, true},
		{"different port", "example.com:8443", "example.com", 443, false},
		{"wildcard port", "*.example.com:8443", "api.example.com", 8443, true},
		{"IPv4 port", "8.8.8.8:8443", "8.8.8.8", 8443, true},
		{"IPv6 port", "[2001:db8::1]:8443", "2001:db8::1", 8443, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := sandbox.Network{Mode: "allowlist", Hosts: []string{test.rule}}
			if err := policy.Validate(); err != nil {
				t.Fatal(err)
			}
			if got := policy.Allows(test.host, test.port, netip.MustParseAddr("8.8.8.8")); got != test.want {
				t.Fatalf("allowed=%t, want %t", got, test.want)
			}
		})
	}
}

func TestNetworkDenyRulesOverrideAllowsAndLocalPorts(t *testing.T) {
	for _, test := range []struct {
		name, mode, denied, host, address string
		port                              int
		want                              bool
	}{
		{"deny overrides on", "on", "api.example.com", "api.example.com", "8.8.8.8", 443, false},
		{"deny overrides wildcard", "allowlist", "api.example.com", "api.example.com", "8.8.8.8", 443, false},
		{"wildcard deny", "on", "*.example.com", "api.example.com", "8.8.8.8", 443, false},
		{"port deny", "on", "api.example.com:8443", "api.example.com", "8.8.8.8", 8443, false},
		{"other port allowed", "on", "api.example.com:8443", "api.example.com", "8.8.8.8", 443, true},
		{"local deny", "on", "localhost", "localhost", "127.0.0.1", 443, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := sandbox.Network{Mode: test.mode, Hosts: []string{"*.example.com"}, Deny: []string{test.denied}, LocalPorts: []int{443}}
			if err := policy.Validate(); err != nil {
				t.Fatal(err)
			}
			if got := policy.Allows(test.host, test.port, netip.MustParseAddr(test.address)); got != test.want {
				t.Fatalf("allowed=%t, want %t", got, test.want)
			}
		})
	}
}

func TestNetworkRulesRejectRebindingToReservedAddresses(t *testing.T) {
	policy := sandbox.Network{Mode: "on", LocalPorts: []int{443}}
	for _, address := range []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"} {
		t.Run(address, func(t *testing.T) {
			if policy.Allows("public.example.com", 443, netip.MustParseAddr(address)) {
				t.Fatal("public hostname reached a reserved destination")
			}
		})
	}
}
