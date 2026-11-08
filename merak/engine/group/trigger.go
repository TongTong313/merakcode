package group

import (
	"errors"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/internal/platform/pathglob"
)

// Trigger data lives with settings so the group does not depend on its leader.
type Trigger struct {
	ID       event.ID      `json:"id"`
	When     event.Filter  `json:"when"`
	Where    string        `json:"where,omitempty"`
	Then     Action        `json:"then"`
	Cooldown time.Duration `json:"cooldown,omitempty"`
}

type Priority int
type ActionKind string

const (
	CreateTask   ActionKind = "create_task"
	NotifyHuman  ActionKind = "notify_human"
	WakeLeader   ActionKind = "wake_leader"
	AssignMember ActionKind = "assign_member"
)

type Action struct {
	Kind     ActionKind `json:"kind"`
	Template string     `json:"template,omitempty"`
	Member   event.ID   `json:"member,omitempty"`
	Priority Priority   `json:"priority,omitempty"`
}

func ValidateTriggers(rules []Trigger) error {
	seen := map[event.ID]bool{}
	for _, rule := range rules {
		if rule.ID == "" || seen[rule.ID] || len(rule.When.Types) == 0 || rule.Cooldown < 0 {
			return errors.New("trigger requires a unique id, event types and a nonnegative cooldown")
		}
		seen[rule.ID] = true
		if _, err := pathglob.Compile(rule.Where); err != nil {
			return err
		}
		switch rule.Then.Kind {
		case CreateTask, NotifyHuman:
			if strings.TrimSpace(rule.Then.Template) == "" {
				return errors.New("trigger action requires a template")
			}
		case AssignMember:
			if rule.Then.Member == "" {
				return errors.New("assignment trigger requires a member")
			}
		case WakeLeader:
		default:
			return errors.New("unsupported trigger action")
		}
		if rule.Then.Priority < 0 || rule.Then.Priority > 3 {
			return errors.New("invalid trigger priority")
		}
	}
	return nil
}
