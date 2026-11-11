package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type CloudLoginParams struct {
	Dev      bool   `json:"dev,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
}
type CloudStatus struct {
	Account  string `json:"account,omitempty"`
	Device   string `json:"device,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
	Online   bool   `json:"online"`
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

// DeviceAssignment selects an already registered local member and its checkout.
type DeviceAssignment struct {
	Cause       event.ID    `json:"cause,omitempty"`
	SourceGroup event.ID    `json:"sourceGroup"`
	Member      event.ID    `json:"member"`
	Claim       task.Claim  `json:"claim"`
	Session     event.ID    `json:"session"`
	Scope       event.Scope `json:"scope"`
	Packet      string      `json:"packet"`
}
type DeviceMessage struct {
	Claim event.ID   `json:"claim"`
	Input loop.Input `json:"input"`
}
type DeviceToolCall struct {
	SourceGroup event.ID    `json:"sourceGroup"`
	Member      event.ID    `json:"member"`
	Scope       event.Scope `json:"scope"`
	Call        tool.Call   `json:"call"`
}
type CloudInbound struct {
	Cause         event.ID          `json:"cause,omitempty"`
	QuestionReply *DeviceAnswer     `json:"questionReply,omitempty"`
	Assignment    *DeviceAssignment `json:"assignment,omitempty"`
	Message       *DeviceMessage    `json:"message,omitempty"`
	Cancel        *event.ID         `json:"cancel,omitempty"`
	Reply         *DeviceReply      `json:"reply,omitempty"`
	Notice        *group.Notice     `json:"notice,omitempty"`
	Scope         event.Scope       `json:"scope,omitempty"`
	Events        []event.Event     `json:"events,omitempty"`
	ToolCall      *DeviceToolCall   `json:"toolCall,omitempty"`
}
