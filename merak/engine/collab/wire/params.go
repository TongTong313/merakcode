package wire

import (
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type PermissionReplyParams struct {
	Leader   event.ID            `json:"leader,omitempty"`
	Remember string              `json:"remember,omitempty"`
	Request  event.ID            `json:"request"`
	Decision permission.Decision `json:"decision"`
}

type QuestionReplyParams struct {
	Request   event.ID `json:"request"`
	Text      string   `json:"text,omitempty"`
	Cancelled bool     `json:"cancelled,omitempty"`
}

type SandboxStatusParams struct {
	Group   event.ID        `json:"group,omitempty"`
	Member  event.ID        `json:"member,omitempty"`
	Session event.ID        `json:"session,omitempty"`
	Workdir string          `json:"workdir,omitempty"`
	Mode    permission.Mode `json:"mode,omitempty"`
}
