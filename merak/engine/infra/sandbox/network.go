package sandbox

import (
	"net"
	"net/netip"
	"slices"
	"strconv"
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
	if n.DeniesHost(host, port) {
		return false
	}
	if address.IsLoopback() {
		literal, err := netip.ParseAddr(host)
		local := normalizeHost(host) == "localhost" || err == nil && literal.Unmap().IsLoopback()
		return local && slices.Contains(n.LocalPorts, port)
	}
	return publicNetworkAddress(address) && n.AllowsHost(host, port)
}

// IANA special-purpose registries identify private, shared, documentation and reserved destinations.
var reservedNetworkPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"),
}

func publicNetworkAddress(address netip.Addr) bool {
	if !address.IsGlobalUnicast() || address.IsPrivate() {
		return false
	}
	return !slices.ContainsFunc(reservedNetworkPrefixes, func(prefix netip.Prefix) bool { return prefix.Contains(address) })
}

func (n Network) AllowsHost(host string, port int) bool {
	if n.DeniesHost(host, port) {
		return false
	}
	if n.Mode == "on" {
		return true
	}
	if n.Mode != "allowlist" {
		return false
	}
	return slices.ContainsFunc(n.Hosts, func(allowed string) bool {
		return matchesNetworkRule(allowed, host, port)
	})
}

func (n Network) DeniesHost(host string, port int) bool {
	return slices.ContainsFunc(n.Deny, func(rule string) bool {
		return matchesNetworkRule(rule, host, port)
	})
}

func (n Network) denialSource(host string, port int) string {
	for _, rule := range n.Deny {
		if matchesNetworkRule(rule, host, port) {
			return n.DenySources[rule]
		}
	}
	return ""
}

func parseNetworkRule(rule string) (string, int, bool) {
	if validHost(rule) {
		return normalizeHost(rule), 0, true
	}
	host, portText, err := net.SplitHostPort(rule)
	port := 0
	if err == nil {
		port, err = strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return "", 0, false
		}
	} else {
		host = rule
	}
	if strings.HasPrefix(host, "*.") {
		return normalizeHost(host), port, validHost(strings.TrimPrefix(host, "*."))
	}
	return normalizeHost(host), port, validHost(host)
}

func matchesNetworkRule(rule, host string, port int) bool {
	pattern, requiredPort, valid := parseNetworkRule(rule)
	if !valid || requiredPort != 0 && requiredPort != port || !validHost(host) {
		return false
	}
	host = normalizeHost(host)
	if strings.HasPrefix(pattern, "*.") {
		if _, err := netip.ParseAddr(host); err == nil {
			return false
		}
		return strings.HasSuffix(host, pattern[1:])
	}
	if address, err := netip.ParseAddr(host); err == nil {
		allowed, err := netip.ParseAddr(pattern)
		return err == nil && address.Unmap() == allowed.Unmap()
	}
	return pattern == host
}

func normalizeHost(host string) string {
	return strings.TrimSuffix(strings.ToLower(host), ".")
}
