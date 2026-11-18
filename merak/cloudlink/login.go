package cloudlink

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// LoginDevelopment exchanges a device identity only with an explicit local dev host.
func LoginDevelopment(ctx context.Context, endpoint, device string) (wire.Credentials, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || !wire.ValidEndpoint(endpoint) || parsed.Scheme != "ws" || device == "" {
		return wire.Credentials{}, wire.ErrUnavailable
	}
	parsed.Scheme, parsed.Path = "http", "/auth/dev"
	body, _ := json.Marshal(protocol.DevelopmentLogin{Device: device})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), bytes.NewReader(body))
	if err != nil {
		return wire.Credentials{}, wire.ErrUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	client := http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return wire.Credentials{}, wire.ErrUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return wire.Credentials{}, wire.ErrUnavailable
	}
	var token protocol.CloudToken
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16384))
	if decoder.Decode(&token) != nil || decoder.Decode(new(any)) != io.EOF || token.Token == "" || token.Account == "" {
		return wire.Credentials{}, wire.ErrUnavailable
	}
	return wire.Credentials{Endpoint: endpoint, Device: device, Account: token.Account, Token: token.Token}, nil
}
