package cloud

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
)

// Identity separates accounts on different hosts without storing a credential.
func Identity(creds Credentials) string {
	if creds.Account == "" || creds.Endpoint == "" {
		return ""
	}
	endpoint, err := url.Parse(creds.Endpoint)
	if err != nil {
		return ""
	}
	endpoint.Host = strings.ToLower(endpoint.Host)
	if endpoint.Scheme == "ws" && endpoint.Port() == "80" || endpoint.Scheme == "wss" && endpoint.Port() == "443" {
		endpoint.Host = strings.TrimSuffix(endpoint.Host, ":"+endpoint.Port())
	}
	if endpoint.Path == "" {
		endpoint.Path = "/"
	}
	sum := sha256.Sum256([]byte(endpoint.String() + "\x00" + creds.Account))
	return hex.EncodeToString(sum[:])
}
