package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type RemoteConnectParams struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

type RemoteMember struct {
	Member group.Member `json:"member"`
	Caps   worker.Caps  `json:"caps"`
}

type RemoteConnection struct {
	ID       event.ID       `json:"id"`
	Endpoint string         `json:"endpoint"`
	Members  []RemoteMember `json:"members"`
}

type RemoteStartParams struct {
	Host       event.ID         `json:"host"`
	Events     []event.Event    `json:"events"`
	Assignment DeviceAssignment `json:"assignment"`
}

type RemoteStartResult struct {
	Cursors   map[event.Stream]uint64 `json:"cursors"`
	Answered  []event.ID              `json:"answered,omitempty"`
	Completed bool                    `json:"completed,omitempty"`
}

type RemoteSyncParams struct {
	Host   event.ID      `json:"host"`
	Group  event.ID      `json:"group"`
	Events []event.Event `json:"events"`
}

type RemoteDeliveryParams struct {
	Host    event.ID `json:"host"`
	Claim   event.ID `json:"claim"`
	Release bool     `json:"release,omitempty"`
}

type RemoteDelivery struct {
	Branch string `json:"branch"`
}

type RemoteControlParams struct {
	Lookup        *RemoteLookupReply     `json:"lookup,omitempty"`
	Message       *DeviceMessage         `json:"message,omitempty"`
	Cancel        *event.ID              `json:"cancel,omitempty"`
	Reply         *PermissionReplyParams `json:"reply,omitempty"`
	QuestionReply *QuestionReplyParams   `json:"questionReply,omitempty"`
}

const RemoteLookupRequested event.Type = "reference.requested"

func init() { event.Register[tool.Call](RemoteLookupRequested) }

type RemoteLookupReply struct {
	Request event.ID    `json:"request"`
	Result  tool.Result `json:"result"`
}
