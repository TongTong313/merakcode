package server_test

import (
	"errors"
	"testing"

	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestClientToolMethodsAreUnavailable(t *testing.T) {
	r := newRoster(t)
	for _, method := range []string{"tool.register", "tool.unregister", "tool.result"} {
		t.Run(method, func(t *testing.T) {
			err := r.client.Call(t.Context(), method, struct{}{}, nil)
			var failure *protocol.Error
			if !errors.As(err, &failure) || failure.Code != -32601 {
				t.Fatalf("%s: err=%v, want method not found", method, err)
			}
		})
	}
}
