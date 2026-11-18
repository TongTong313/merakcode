package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type CloudLoginParams struct {
	Dev      bool   `json:"dev,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
}

type DevelopmentLogin struct {
	Device string `json:"device"`
}
type CloudToken struct {
	Account string `json:"account"`
	Token   string `json:"token"`
}

// DeviceEventChunk carries a single oversized event without changing its identity.
// The host acknowledges the final chunk only after persisting the reconstructed event.
// Retrying the same digest and offset must be idempotent.
type DeviceEventChunk struct {
	Event  event.ID `json:"event"`
	Digest string   `json:"digest"`
	Offset int      `json:"offset"`
	Total  int      `json:"total"`
	Data   []byte   `json:"data"`
}
