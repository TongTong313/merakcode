// Package remote runs registered members through another engine's Go protocol client.
package remote

import (
	"context"
	"errors"
	"net/url"
	"time"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func ValidEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	return err == nil && (parsed.Scheme == "ws" || parsed.Scheme == "wss") && parsed.Hostname() != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func Members(ctx context.Context, endpoint, token string) ([]protocol.RemoteMember, error) {
	if !ValidEndpoint(endpoint) || token == "" {
		return nil, errors.New("MRK-3001")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client, err := protocol.Connect(ctx, endpoint, token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "merak-remote"}})
	if err != nil {
		return nil, err
	}
	defer client.Close()
	var members []protocol.RemoteMember
	err = client.Call(ctx, "remote.members", struct{}{}, &members)
	return members, err
}
