package wire

import (
	"net"
	"net/url"
)

func ValidEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return false
	}
	if parsed.Scheme == "wss" {
		return true
	}
	return parsed.Scheme == "ws" && (parsed.Hostname() == "localhost" || net.ParseIP(parsed.Hostname()).IsLoopback())
}
