package wire

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type CloudStatus struct {
	Account  string `json:"account,omitempty"`
	Device   string `json:"device,omitempty"`
	Endpoint string `json:"endpoint,omitempty"`
	Online   bool   `json:"online"`
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
