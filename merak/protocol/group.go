package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type GroupCreateParams struct {
	group.Group
	Members []group.Member `json:"members"`
	// Task is a task no group has taken; the new group works in its workspace and takes it.
	Task event.ID `json:"task,omitempty"`
}

// GroupBindParams gives a task that no group has taken to an existing group.
type GroupBindParams struct {
	Group event.ID `json:"group"`
	Task  event.ID `json:"task"`
}
type GroupIDParams struct {
	Group event.ID `json:"group"`
}

type GroupRemoveMemberParams struct {
	Group  event.ID `json:"group"`
	Member event.ID `json:"member"`
}

// GroupRenameMemberParams gives a member another name in one group.
type GroupRenameMemberParams struct {
	Group  event.ID `json:"group"`
	Member event.ID `json:"member"`
	Name   string   `json:"name"`
}

type GroupUpdateParams struct {
	Group event.ID `json:"group"`
	group.Update
}
type GroupAddMemberParams struct {
	Group  event.ID     `json:"group"`
	Member group.Member `json:"member"`
}
type TaskCreateParams struct {
	Budget      task.Budget `json:"budget,omitempty"`
	Workspace   string      `json:"workspace,omitempty"`
	Inputs      []string    `json:"inputs,omitempty"`
	Member      event.ID    `json:"member,omitempty"`
	Review      bool        `json:"review,omitempty"`
	Priority    int         `json:"priority,omitempty"`
	Group       event.ID    `json:"group,omitempty"`
	Project     string      `json:"project,omitempty"`
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

// TaskListParams filters the tasks of every group.
type TaskListParams struct {
	Project  string `json:"project,omitempty"`
	Archived bool   `json:"archived,omitempty"`
}

// TaskArchiveParams hides finished tasks from the board, or brings them back.
type TaskArchiveParams struct {
	Tasks    []event.ID `json:"tasks"`
	Archived bool       `json:"archived"`
}
