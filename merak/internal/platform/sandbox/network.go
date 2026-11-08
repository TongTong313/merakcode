package sandbox

import (
	"net/netip"
	"slices"
	"strings"
)

// Allows checks the resolved address as well as the requested hostname.
func (n Network) Allows(host string, port int, address netip.Addr) bool {
	if n.Mode != "" && n.Mode != "off" && n.Mode != "allowlist" && n.Mode != "on" {
		return false
	}
	if port < 1 || port > 65535 || slices.Contains(n.BlockedPorts, port) || !address.IsValid() || address.Zone() != "" {
		return false
	}
	address = address.Unmap()
	if address.IsLoopback() {
		return slices.Contains(n.LocalPorts, port)
	}
	return address.IsGlobalUnicast() && n.permitsHost(host)
}

func (n Network) permitsHost(host string) bool {
	if n.Mode == "on" {
		return true
	}
	if n.Mode != "allowlist" {
		return false
	}
	host = normalizeHost(host)
	return slices.ContainsFunc(n.Hosts, func(allowed string) bool {
		return normalizeHost(allowed) == host
	})
}

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(host), ".")
}
