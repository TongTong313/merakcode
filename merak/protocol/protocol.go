// Package protocol defines the public JSON-RPC contract and the Go client.
package protocol

import (
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
)

const Version = 1

type ConnectionInfo struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
	PID      int    `json:"pid"`
	Protocol int    `json:"protocol"`
}

type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type HelloParams struct {
	Protocol     int          `json:"protocol"`
	Client       ClientInfo   `json:"client"`
	Capabilities Capabilities `json:"capabilities,omitempty"`
}

type Capabilities struct {
	Store   bool `json:"store,omitempty"`
	Approve bool `json:"approve,omitempty"`
}

type PermissionReplyParams struct {
	Remember string              `json:"remember,omitempty"`
	Human    event.ID            `json:"human,omitempty"`
	Request  event.ID            `json:"request"`
	Decision permission.Decision `json:"decision"`
}

type QuestionReplyParams struct {
	Human     event.ID `json:"human,omitempty"`
	Request   event.ID `json:"request"`
	Text      string   `json:"text,omitempty"`
	Cancelled bool     `json:"cancelled,omitempty"`
}

type HelloResult struct {
	Store    string `json:"store,omitempty"`
	Protocol int    `json:"protocol"`
	Engine   string `json:"engine"`
}

type SessionCreateParams struct {
	Mode     permission.Mode `json:"mode,omitempty"`
	Provider string          `json:"provider,omitempty"`
	Model    string          `json:"model,omitempty"`
	Thinking model.Thinking  `json:"thinking,omitempty"`
	Workdir  string          `json:"workdir,omitempty"`
}

type SandboxStatusParams struct {
	Session event.ID        `json:"session,omitempty"`
	Workdir string          `json:"workdir,omitempty"`
	Mode    permission.Mode `json:"mode,omitempty"`
}

type SessionCreateResult struct {
	Session event.ID `json:"session"`
}

type SessionSendParams struct {
	Selection *session.Selection `json:"selection,omitempty"`
	Session   event.ID           `json:"session"`
	Parts     []model.Part       `json:"parts"`
}

type SessionCancelParams struct {
	Session event.ID `json:"session"`
}

type SubscribeResult struct {
	Subscription event.ID `json:"subscription"`
}
type UnsubscribeParams struct {
	Subscription event.ID `json:"subscription"`
}

type ErrorData struct {
	Code string `json:"code"`
}

type Error struct {
	Code    int       `json:"code"`
	Message string    `json:"message"`
	Data    ErrorData `json:"data"`
}

func (e *Error) Error() string { return e.Data.Code }

type Message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}
