package session

import "github.com/TongTong313/merakcode/merak/engine/event"

// ReviewUpdated says that the person accepted or rejected changes of the conversation, or undid that. Clients that
// show the review read it again.
const ReviewUpdated event.Type = "review.updated"

func init() { event.Register[ReviewUpdate](ReviewUpdated) }

// ReviewUpdate is the payload of ReviewUpdated: what was decided ("accept", "reject" or "undo") and on how many files.
type ReviewUpdate struct {
	Decision string `json:"decision"`
	Count    int    `json:"count"`
}
