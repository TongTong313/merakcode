package task

import "github.com/TongTong313/merakcode/merak/engine/event"

// Offered records that an idle Worker was invited to claim a task, so the invitation is never repeated.
const Offered event.Type = "task.offered"

// Offer is the payload of Offered.
type Offer struct {
	Task   event.ID `json:"task"`
	Member event.ID `json:"member"`
}

func init() { event.Register[Offer](Offered) }

// Claimable lists the cards a Worker may be offered: open, held by nobody, made by an agent (the Leader's own
// split, so the Leader has already decided to leave them for whoever fits) and not split further.
func Claimable(cards []Card) []Card {
	parents := make(map[event.ID]bool)
	for _, card := range cards {
		if card.Parent != "" {
			parents[card.Parent] = true
		}
	}
	var open []Card
	for _, card := range cards {
		if card.Status == Open && len(card.Claims) == 0 && !card.Archived && card.CreatedBy.Kind == event.ActorAgent && !parents[card.ID] {
			open = append(open, card)
		}
	}
	return open
}
