// Package cloud owns the outbound device link to the cloud service.
package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/protocol"
)

var ErrNoCloud = errors.New("MRK-1006")
var ErrUnavailable = errors.New("MRK-1007")

type Credentials struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
	Account  string `json:"account"`
	Device   string `json:"device"`
}

type Inbound = protocol.CloudInbound

type Link interface {
	Connect(context.Context, Credentials) error
	Announce(context.Context, []group.Member) error
	Forward(context.Context, string, json.RawMessage) (json.RawMessage, error)
	Inbound() <-chan Inbound
	Publish(context.Context, []event.Event) error
}

type Null struct{}

func (Null) Connect(context.Context, Credentials) error     { return ErrNoCloud }
func (Null) Announce(context.Context, []group.Member) error { return ErrNoCloud }
func (Null) Forward(context.Context, string, json.RawMessage) (json.RawMessage, error) {
	return nil, ErrNoCloud
}
func (Null) Inbound() <-chan Inbound                      { return nil }
func (Null) Publish(context.Context, []event.Event) error { return ErrNoCloud }
