package server_test

import (
	"slices"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

// No agent is a Leader or a Worker by nature: the group gives the seat, and MerakCode itself is one agent that can
// take either.

func seat(id string, agentID event.ID, role group.AgentRole) group.Member {
	return group.Member{ID: event.ID(id), Name: id, Kind: group.MemberAgent, AgentRole: role, Agent: agentID}
}

func TestMerakCodeIsOneAgentThatCanLeadAndWorkInTheSameGroup(t *testing.T) {
	r := newRoster(t)
	var agents []agent.Agent
	if err := r.client.Call(t.Context(), "agent.list", struct{}{}, &agents); err != nil {
		t.Fatal(err)
	}
	var builtin []event.ID
	for _, found := range agents {
		if found.Source == "" && found.Product == nil && len(found.ID) > 8 && found.ID[:8] == "builtin-" {
			builtin = append(builtin, found.ID)
		}
	}
	if !slices.Equal(builtin, []event.ID{"builtin-merakcode"}) {
		t.Fatalf("built-in agents = %v, want only builtin-merakcode", builtin)
	}
	g, err := r.create("lead", r.directory, r.members(
		seat("lead", "builtin-merakcode", group.AgentLeader),
		seat("hand", "builtin-merakcode", group.AgentWorker),
		seat("other", "builtin-merakcode", group.AgentWorker),
	))
	if err != nil {
		t.Fatalf("MerakCode as Leader and as Workers of one group was refused: %v", err)
	}
	state := r.state(g.ID)
	roles := map[event.ID]group.AgentRole{}
	for _, member := range state.Members {
		if member.Kind == group.MemberAgent {
			roles[member.ID] = member.AgentRole
		}
	}
	if roles["lead"] != group.AgentLeader || roles["hand"] != group.AgentWorker || roles["other"] != group.AgentWorker {
		t.Fatalf("seats = %v", roles)
	}
}

func TestAnAgentSavedWithoutARoleCanBeChosenAsTheLeaderOrAsAWorker(t *testing.T) {
	r := newRoster(t)
	var saved agent.Agent
	if err := r.client.Call(t.Context(), "agent.save", map[string]any{"agent": map[string]any{"name": "Reviewer", "summary": "Looks at changes", "model": map[string]any{"provider": "", "model": ""}}}, &saved); err != nil || saved.ID == "" {
		t.Fatalf("agent.save without a role = %+v, %v", saved, err)
	}
	g, err := r.create("lead", r.directory, r.members(seat("lead", "builtin-merakcode", group.AgentLeader), seat("rev", saved.ID, group.AgentWorker)))
	if err != nil {
		t.Fatalf("the agent was refused as a Worker: %v", err)
	}
	if err := r.client.Call(t.Context(), "group.update", map[string]any{"group": g.ID, "leader": saved.ID}, nil); err != nil {
		t.Fatalf("the agent was refused as the Leader: %v", err)
	}
	var leaders []group.Member
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		leaders = nil
		for _, member := range r.state(g.ID).Members {
			if member.Kind == group.MemberAgent && member.AgentRole == group.AgentLeader {
				leaders = append(leaders, member)
			}
		}
		if len(leaders) == 1 && leaders[0].Agent == saved.ID {
			return
		}
	}
	t.Fatalf("leaders after the change = %+v", leaders)
}
