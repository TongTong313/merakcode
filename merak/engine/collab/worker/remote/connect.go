// Package remote runs registered members through a supplied engine connection.
package remote

import (
	"context"
	"errors"
	"net/url"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
)

func ValidEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	return err == nil && (parsed.Scheme == "ws" || parsed.Scheme == "wss") && parsed.Hostname() != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}

func Members(ctx context.Context, dial wire.Dial, endpoint, token string) ([]wire.RemoteMember, error) {
	if dial == nil || !ValidEndpoint(endpoint) || token == "" {
		return nil, errors.New("MRK-3001")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	client, err := dial(ctx, endpoint, token, "merak-remote")
	if err != nil {
		return nil, err
	}
	defer client.Close()
	var members []wire.RemoteMember
	err = client.Call(ctx, "remote.members", struct{}{}, &members)
	return members, err
}
