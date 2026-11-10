package group

import "time"

type Role = string

const (
	RoleObserver Role = "observer"
	RoleMember   Role = "member"
	RoleApprover Role = "approver"
	RoleAdmin    Role = "admin"
	RoleOwner    Role = "owner"
)

type Settings struct {
	ApprovalTimeout   time.Duration `json:"approvalTimeout,omitempty"`
	TurnsPerMinute    *TurnLimits   `json:"turnsPerMinute,omitempty"`
	Setup             []string      `json:"setup,omitempty"`
	Initiative        Initiative    `json:"initiative,omitempty"`
	Triggers          []Trigger     `json:"triggers,omitempty"`
	Review            *bool         `json:"review,omitempty"`
	PlanNeedsApproval bool          `json:"planNeedsApproval,omitempty"`
	AllowedHosts      []string      `json:"allowedHosts,omitempty"`
	DeniedHosts       []string      `json:"deniedHosts,omitempty"`
	MergeNeedsOwner   *bool         `json:"mergeNeedsOwner,omitempty"`
}

func (s Settings) ApprovalWait(fallback time.Duration) time.Duration {
	if s.ApprovalTimeout > 0 {
		return s.ApprovalTimeout
	}
	if fallback > 0 {
		return fallback
	}
	return 30 * time.Minute
}

type TurnLimits struct {
	Thread *int `json:"thread,omitempty"`
	Group  *int `json:"group,omitempty"`
}

func (l *TurnLimits) Values() (thread, group int) {
	thread, group = 6, 30
	if l != nil {
		if l.Thread != nil {
			thread = *l.Thread
		}
		if l.Group != nil {
			group = *l.Group
		}
	}
	return
}

type Initiative string

const (
	Passive Initiative = "passive"
	Normal  Initiative = "normal"
	Eager   Initiative = "eager"
)

func (s Settings) ReviewRequired() bool { return s.Review == nil || *s.Review }

func (s Settings) MergeApprovalRequired() bool { return s.MergeNeedsOwner == nil || *s.MergeNeedsOwner }

func (m Member) Can(role Role) bool {
	if m.Kind != MemberHuman {
		return false
	}
	ranks := map[Role]int{RoleObserver: 1, RoleMember: 2, RoleApprover: 3, RoleAdmin: 4, RoleOwner: 5}
	return ranks[role] > 0 && ranks[m.Role] >= ranks[role]
}
