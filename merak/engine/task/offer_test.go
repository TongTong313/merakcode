package task_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestOnlyUnheldLeaderMadeLeafTasksAreClaimable(t *testing.T) {
	leader := event.Actor{Kind: event.ActorAgent, ID: "leader"}
	human := event.Actor{Kind: event.ActorHuman, ID: "owner"}
	cards := []task.Card{
		{ID: "goal", Status: task.Open, CreatedBy: leader},
		{ID: "child", Parent: "goal", Status: task.Open, CreatedBy: leader},
		{ID: "held", Status: task.Open, CreatedBy: leader, Claims: []task.Claim{{ID: "c", Member: "writer"}}},
		{ID: "archived", Status: task.Open, CreatedBy: leader, Archived: true},
		{ID: "done", Status: task.Done, CreatedBy: leader},
		{ID: "asked-by-human", Status: task.Open, CreatedBy: human},
		{ID: "free", Status: task.Open, CreatedBy: leader},
	}
	var got []string
	for _, card := range task.Claimable(cards) {
		got = append(got, string(card.ID))
	}
	if len(got) != 2 || got[0] != "child" || got[1] != "free" {
		t.Fatalf("claimable = %v", got)
	}
}
