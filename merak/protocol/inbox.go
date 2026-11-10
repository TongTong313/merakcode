package protocol

import (
	"context"
	"slices"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

type InboxNotice struct {
	group.Notice
	ID      event.ID    `json:"id"`
	Request event.ID    `json:"request,omitempty"`
	Scope   event.Scope `json:"scope"`
	Time    time.Time   `json:"time"`
}

// GroupInbox derives current notices from the same event history used by other clients.
func (c *Client) GroupInbox(ctx context.Context, id, human event.ID) ([]InboxNotice, error) {
	var facts []event.Event
	if err := c.Call(ctx, "events.find", store.Query{Scope: event.Scope{Group: id}}, &facts); err != nil {
		return nil, err
	}
	notices := []InboxNotice{}
	answered := map[event.ID]bool{}
	checkpoints := map[event.ID]map[string]event.ID{}
	for _, fact := range facts {
		switch fact.Type {
		case group.NoticeSent:
			notice, err := event.Decode[group.Notice](fact)
			if err != nil {
				return nil, err
			}
			if !slices.Contains(notice.To, human) || answered[fact.Cause] {
				continue
			}
			if point, known := checkpoints[fact.Scope.Task]; known && (notice.Kind == "review" || notice.Kind == "plan") && (point[notice.Kind] == "" || point[notice.Kind] != fact.Cause) {
				continue
			}
			if notice.Kind == "review" || notice.Kind == "plan" {
				notices = slices.DeleteFunc(notices, func(n InboxNotice) bool { return n.Kind == notice.Kind && n.Scope.Task == fact.Scope.Task })
			}
			notices = append(notices, InboxNotice{Notice: notice, ID: fact.ID, Request: fact.Cause, Scope: fact.Scope, Time: fact.Time})
		case permission.Replied, question.Answered:
			if fact.Cause != "" {
				answered[fact.Cause] = true
				notices = slices.DeleteFunc(notices, func(n InboxNotice) bool { return n.Request == fact.Cause })
			}
		case task.Closed, task.Reviewed, task.Updated, task.PhaseChanged, task.Reported:
			card, err := event.Decode[task.Card](fact)
			if err != nil {
				return nil, err
			}
			point := checkpoints[fact.Scope.Task]
			if point == nil {
				point = map[string]event.ID{}
			}
			switch {
			case fact.Type == task.Closed || fact.Type == task.Reviewed || fact.Type == task.Updated && card.Status == task.Blocked:
				point = map[string]event.ID{}
			case fact.Type == task.PhaseChanged:
				delete(point, "review")
				if card.Phase == task.PhaseReview {
					point["review"] = fact.ID
				}
				if !card.PlanPending {
					delete(point, "plan")
				}
			case fact.Type == task.Reported && card.Status == task.Review:
				point["review"] = fact.ID
			case fact.Type == task.Updated:
				if !card.PlanPending {
					delete(point, "plan")
				} else if point["plan"] == "" {
					point["plan"] = fact.ID
				}
			}
			checkpoints[fact.Scope.Task] = point
			notices = slices.DeleteFunc(notices, func(n InboxNotice) bool {
				if n.Scope.Task != fact.Scope.Task {
					return false
				}
				if fact.Type == task.Closed {
					return n.Kind == "review" || n.Kind == "plan" || n.Kind == "permission" || n.Kind == "question"
				}
				if n.Kind != "review" && n.Kind != "plan" {
					return false
				}
				if fact.Type == task.Reviewed || card.Status == task.Blocked {
					return true
				}
				return fact.Type == task.PhaseChanged && (n.Kind == "review" && card.Phase != task.PhaseReview || n.Kind == "plan" && !card.PlanPending)
			})
		}
	}
	return notices, nil
}
