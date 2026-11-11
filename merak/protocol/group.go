package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type GroupCreateParams struct {
	group.Group
	Members  []group.Member    `json:"members"`
	Profiles []profile.Profile `json:"profiles"`
}
type GroupIDParams struct {
	Group event.ID `json:"group"`
}

type GroupControlParams struct {
	Group  event.ID `json:"group"`
	Thread event.ID `json:"thread,omitempty"`
}

type GroupRemoveMemberParams struct {
	Group  event.ID `json:"group"`
	Member event.ID `json:"member"`
}

type GroupUpdateParams struct {
	Group event.ID `json:"group"`
	group.Update
}
type GroupAddMemberParams struct {
	Group   event.ID         `json:"group"`
	Member  group.Member     `json:"member"`
	Profile *profile.Profile `json:"profile,omitempty"`
}
type TaskCreateParams struct {
	Budget      task.Budget `json:"budget,omitempty"`
	Workspace   string      `json:"workspace,omitempty"`
	Inputs      []string    `json:"inputs,omitempty"`
	Member      event.ID    `json:"member,omitempty"`
	Review      bool        `json:"review,omitempty"`
	Priority    int         `json:"priority,omitempty"`
	Group       event.ID    `json:"group"`
	Leader      event.ID    `json:"leader,omitempty"`
	Title       string      `json:"title"`
	Description string      `json:"description,omitempty"`
	Acceptance  []string    `json:"acceptance,omitempty"`
	Areas       []string    `json:"areas,omitempty"`
}

type GroupSayParams struct {
	Group event.ID `json:"group"`
	Task  event.ID `json:"task,omitempty"`
	group.Message
}

type TaskAssignParams struct {
	Task   event.ID       `json:"task"`
	Member event.ID       `json:"member"`
	Role   task.ClaimRole `json:"role,omitempty"`
	Scope  []string       `json:"scope,omitempty"`
}

type TaskReviewParams struct {
	Task     event.ID `json:"task"`
	Decision string   `json:"decision"`
	Feedback string   `json:"feedback,omitempty"`
}

type TaskUpdateParams struct {
	Task event.ID `json:"task"`
	task.Update
}

type TaskCancelParams struct {
	Task event.ID `json:"task"`
}
