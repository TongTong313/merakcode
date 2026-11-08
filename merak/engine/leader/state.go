// Package leader routes group work and builds bounded context for coordinator sessions.
package leader

import (
	"fmt"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/window"
)

type GoalLine struct {
	Phase  task.Phase  `json:"phase,omitempty"`
	ID     event.ID    `json:"id"`
	Title  string      `json:"title"`
	Status task.Status `json:"status"`
	Owner  event.ID    `json:"owner"`
}
type TaskLine struct {
	ID         event.ID    `json:"id"`
	Parent     event.ID    `json:"parent,omitempty"`
	Leader     event.ID    `json:"leader"`
	Title      string      `json:"title"`
	Status     task.Status `json:"status"`
	Assignee   event.ID    `json:"assignee,omitempty"`
	Claim      event.ID    `json:"claim,omitempty"`
	Queue      int         `json:"queue"`
	Summary    string      `json:"summary"`
	LastReport event.ID    `json:"lastReport,omitempty"`
	Claims     []ClaimLine `json:"claims,omitempty"`
}
type ClaimLine struct {
	ID     event.ID         `json:"id"`
	Member event.ID         `json:"member"`
	Status task.ClaimStatus `json:"status"`
}
type MemberLine struct {
	ID      event.ID         `json:"id"`
	Name    string           `json:"name"`
	Kind    group.MemberKind `json:"kind"`
	Role    string           `json:"role"`
	Status  group.Status     `json:"status"`
	Current event.ID         `json:"current,omitempty"`
	Queue   int              `json:"queue"`
}
type State struct {
	mu      sync.Mutex
	LastSeq uint64       `json:"lastSeq"`
	Rev     uint64       `json:"rev"`
	Goals   []GoalLine   `json:"goals"`
	Tasks   []TaskLine   `json:"tasks"`
	Members []MemberLine `json:"members"`
}

func (s *State) Apply(fact event.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastSeq = max(s.LastSeq, fact.Seq)
	switch fact.Type {
	case task.Progressed:
		progress, err := event.Decode[task.Progress](fact)
		if err != nil {
			return err
		}
		for i := range s.Tasks {
			if s.Tasks[i].ID == fact.Scope.Task {
				s.Tasks[i].Summary = progress.Summary
				break
			}
		}
	case group.Created:
		value, err := event.Decode[group.State](fact)
		if err != nil {
			return err
		}
		for _, member := range value.Members {
			s.addMember(member)
		}
	case group.MemberAdded:
		member, err := event.Decode[group.Member](fact)
		if err != nil {
			return err
		}
		s.addMember(member)
	case task.Created, task.Opened, task.QueuedEvent, task.Started, task.Reported, task.Closed, task.Updated, task.Reviewed, task.PhaseChanged:
		card, err := event.Decode[task.Card](fact)
		if err != nil {
			return err
		}
		line := TaskLine{ID: card.ID, Parent: card.Parent, Leader: card.Leader, Title: card.Title, Status: card.Status}
		for _, claim := range card.Claims {
			line.Claims = append(line.Claims, ClaimLine{ID: claim.ID, Member: claim.Member, Status: claim.Status})
		}
		if len(card.Claims) > 0 {
			claim := card.Claims[0]
			line.Assignee, line.Claim = claim.Member, claim.ID
			if claim.Report != nil {
				line.Summary = claim.Report.Summary
			}
		}
		index := -1
		for i, previous := range s.Tasks {
			if previous.ID == card.ID {
				index = i
				line.LastReport = previous.LastReport
				break
			}
		}
		if fact.Type == task.Reported {
			line.LastReport = fact.ID
		}
		if index < 0 {
			s.Tasks = append(s.Tasks, line)
		} else {
			s.Tasks[index] = line
		}
		if card.Parent == "" {
			goal := GoalLine{ID: card.ID, Title: card.Title, Status: card.Status, Owner: card.CreatedBy.ID, Phase: card.Phase}
			index := -1
			for i, old := range s.Goals {
				if old.ID == card.ID {
					index = i
					break
				}
			}
			if index < 0 {
				s.Goals = append(s.Goals, goal)
			} else {
				s.Goals[index] = goal
			}
		}
	default:
		return nil
	}
	for i := range s.Tasks {
		s.Tasks[i].Queue = 0
	}
	for i := range s.Members {
		member := &s.Members[i]
		member.Queue, member.Current = 0, ""
		if member.Status != group.Offline {
			member.Status = group.Idle
		}
		for j := range s.Tasks {
			line := &s.Tasks[j]
			for _, claim := range line.Claims {
				if claim.Member != member.ID {
					continue
				}
				if claim.Status == task.ClaimQueued {
					member.Queue++
					line.Queue++
				}
				if claim.Status == task.ClaimActive {
					member.Current, member.Status = line.ID, group.Busy
				}
			}
		}
	}
	s.Rev++
	return nil
}

type View struct {
	Rev     uint64       `json:"rev"`
	LastSeq uint64       `json:"lastSeq"`
	Goals   []GoalLine   `json:"goals"`
	Tasks   []TaskLine   `json:"tasks"`
	Members []MemberLine `json:"members"`
}

func (s *State) Snapshot() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	tasks := append([]TaskLine(nil), s.Tasks...)
	for i := range tasks {
		tasks[i].Claims = append([]ClaimLine(nil), tasks[i].Claims...)
	}
	return View{Rev: s.Rev, LastSeq: s.LastSeq, Goals: append([]GoalLine(nil), s.Goals...), Tasks: tasks, Members: append([]MemberLine(nil), s.Members...)}
}
func (s *State) addMember(member group.Member) {
	role := member.Role
	if member.Kind == group.MemberAgent {
		role = string(member.AgentRole)
	}
	line := MemberLine{ID: member.ID, Name: member.Name, Kind: member.Kind, Role: role, Status: member.Status}
	for i, previous := range s.Members {
		if previous.ID == member.ID {
			s.Members[i] = line
			return
		}
	}
	s.Members = append(s.Members, line)
}
func (s *State) Root(id event.ID) event.ID {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.root(id)
}
func (s *State) root(id event.ID) event.ID {
	seen := map[event.ID]bool{}
	for id != "" && !seen[id] {
		seen[id] = true
		parent := event.ID("")
		for _, line := range s.Tasks {
			if line.ID == id {
				parent = line.Parent
				break
			}
		}
		if parent == "" {
			return id
		}
		id = parent
	}
	return id
}
func (s *State) Render(budget int, focus event.ID) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, limit := range []int{240, 120, 60, 30, 0} {
		var out strings.Builder
		out.WriteString("## Goals\n| ID | Title | Status | Owner |\n|---|---|---|---|\n")
		for _, goal := range s.Goals {
			ids := string(goal.ID)
			if focus != "" && goal.ID != focus {
				for _, line := range s.Tasks {
					if line.ID != goal.ID && s.root(line.ID) == goal.ID {
						ids += " " + string(line.ID)
					}
				}
			}
			fmt.Fprintf(&out, "| %s | %s | %s | %s |\n", ids, cell(goal.Title, limit), goal.Status, goal.Owner)
		}
		out.WriteString("## Tasks\n| ID | Status | Member | Queue | Report | Summary |\n|---|---|---|---|---|---|\n")
		for _, line := range s.Tasks {
			if focus != "" && s.root(line.ID) != focus {
				continue
			}
			summary := ""
			if focus == "" || s.root(line.ID) == focus {
				summary = cell(line.Summary, limit)
			}
			fmt.Fprintf(&out, "| %s | %s | %s | %d | %s | %s |\n", line.ID, line.Status, line.Assignee, line.Queue, line.LastReport, summary)
		}
		out.WriteString("## Members\n| ID | Name | Role | Status | Current | Queue |\n|---|---|---|---|---|---|\n")
		for _, member := range s.Members {
			fmt.Fprintf(&out, "| %s | %s | %s | %s | %s | %d |\n", member.ID, cell(member.Name, limit), member.Role, member.Status, member.Current, member.Queue)
		}
		if window.EstimateText(out.String()) <= budget {
			return out.String()
		}
	}
	// IDs are the irreducible context; the request budget rejects an impossible limit.
	var out strings.Builder
	out.WriteString("Goals:")
	for _, goal := range s.Goals {
		fmt.Fprintf(&out, " %s", goal.ID)
	}
	out.WriteString("\nTasks:")
	for _, line := range s.Tasks {
		fmt.Fprintf(&out, " %s", line.ID)
	}
	out.WriteString("\nMembers:")
	for _, member := range s.Members {
		fmt.Fprintf(&out, " %s", member.ID)
	}
	return out.String()
}
func cell(value string, limit int) string {
	runes := []rune(value)
	value = string(runes[:min(limit, len(runes))])
	return strings.NewReplacer("|", "/", "\n", " ", "\r", " ").Replace(value)
}
