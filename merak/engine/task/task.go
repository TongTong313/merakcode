package task

import "github.com/TongTong313/merakcode/merak/engine/event"

type Status string

const (
	Draft     Status = "draft"
	Open      Status = "open"
	Queued    Status = "queued"
	Running   Status = "running"
	Review    Status = "review"
	Blocked   Status = "blocked"
	Done      Status = "done"
	Failed    Status = "failed"
	Cancelled Status = "cancelled"
)

type ClaimRole string

const (
	RoleOwner        ClaimRole = "owner"
	RoleCollaborator ClaimRole = "collaborator"
)

type ClaimStatus string

const (
	ClaimQueued    ClaimStatus = "queued"
	ClaimActive    ClaimStatus = "active"
	ClaimReported  ClaimStatus = "reported"
	ClaimAbandoned ClaimStatus = "abandoned"
)

type Card struct {
	Phase          Phase         `json:"phase,omitempty"`
	PreviousPhase  Phase         `json:"previousPhase,omitempty"`
	PreviousStatus Status        `json:"previousStatus,omitempty"`
	PlanPending    bool          `json:"planPending,omitempty"`
	ID             event.ID      `json:"id"`
	Group          event.ID      `json:"group"`
	Parent         event.ID      `json:"parent,omitempty"`
	Leader         event.ID      `json:"leader,omitempty"`
	Title          string        `json:"title"`
	Priority       int           `json:"priority"`
	Description    string        `json:"description"`
	Acceptance     []string      `json:"acceptance"`
	Workspace      string        `json:"workspace,omitempty"`
	Base           string        `json:"base,omitempty"`
	Areas          []string      `json:"areas,omitempty"`
	Inputs         []string      `json:"inputs,omitempty"`
	IntegrationOf  event.ID      `json:"integrationOf,omitempty"`
	Discussion     []event.ID    `json:"discussion,omitempty"`
	Review         bool          `json:"review,omitempty"`
	LastReview     *ReviewResult `json:"lastReview,omitempty"`
	Deps           []event.ID    `json:"deps,omitempty"`
	Status         Status        `json:"status"`
	Claims         []Claim       `json:"claims"`
	CreatedBy      event.Actor   `json:"createdBy"`
}

const (
	Created      event.Type = "task.created"
	Opened       event.Type = "task.opened"
	QueuedEvent  event.Type = "task.queued"
	Started      event.Type = "task.started"
	Reported     event.Type = "task.reported"
	Closed       event.Type = "task.closed"
	Updated      event.Type = "task.updated"
	Reviewed     event.Type = "task.reviewed"
	PhaseChanged event.Type = "phase.changed"
)

var kinds = []event.Type{Created, Opened, QueuedEvent, Started, Reported, Closed, Updated, Reviewed, PhaseChanged}

func init() {
	for _, kind := range kinds {
		event.Register[Card](kind)
	}
}
