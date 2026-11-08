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
		{"off denies remote addresses", sandbox.Network{Mode: "off"}, "example.com", "192.0.2.1", 443, false},
		{"on permits remote addresses", sandbox.Network{Mode: "on"}, "example.com", "192.0.2.1", 443, true},
		{"allowlist permits an exact host", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "EXAMPLE.COM.", "192.0.2.1", 443, true},
		{"allowlist rejects a suffix attack", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "example.com.attacker.test", "192.0.2.1", 443, false},
		{"allowlist rejects an unlisted subdomain", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "sub.example.com", "192.0.2.1", 443, false},
		{"blocked ports override on", sandbox.Network{Mode: "on", BlockedPorts: []int{443}}, "example.com", "192.0.2.1", 443, false},
		{"on does not expose local services", sandbox.Network{Mode: "on"}, "localhost", "127.0.0.1", 1234, false},
		{"allowed hosts cannot rebind to local services", sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}}, "example.com", "127.0.0.1", 1234, false},
		{"off permits an explicit local port", sandbox.Network{Mode: "off", LocalPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, true},
		{"blocked ports override local ports", sandbox.Network{Mode: "off", LocalPorts: []int{1234}, BlockedPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, false},
		{"mapped IPv4 still needs local permission", sandbox.Network{Mode: "on"}, "localhost", "::ffff:127.0.0.1", 1234, false},
		{"rejects unknown modes", sandbox.Network{Mode: "invalid", LocalPorts: []int{1234}}, "localhost", "127.0.0.1", 1234, false},
		{"rejects an unspecified address", sandbox.Network{Mode: "on"}, "0.0.0.0", "0.0.0.0", 443, false},
		{"rejects multicast", sandbox.Network{Mode: "on"}, "224.0.0.1", "224.0.0.1", 443, false},
		{"rejects a zero port", sandbox.Network{Mode: "on"}, "example.com", "192.0.2.1", 0, false},
		{"rejects an oversized port", sandbox.Network{Mode: "on"}, "example.com", "192.0.2.1", 65536, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			address := netip.MustParseAddr(test.address)
			if got := test.policy.Allows(test.host, test.port, address); got != test.want {
				t.Fatalf("allowed = %t, want %t", got, test.want)
			}
		})
	}
}
