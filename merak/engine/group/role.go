package group

type Role = string

const (
	RoleApprover Role = "approver"
	RoleAdmin    Role = "admin"
	RoleOwner    Role = "owner"
)

type Settings struct {
	Initiative        Initiative `json:"initiative,omitempty"`
	Triggers          []Trigger  `json:"triggers,omitempty"`
	Review            *bool      `json:"review,omitempty"`
	PlanNeedsApproval bool       `json:"planNeedsApproval,omitempty"`
	AllowedHosts      []string   `json:"allowedHosts,omitempty"`
	DeniedHosts       []string   `json:"deniedHosts,omitempty"`
	MergeNeedsOwner   bool       `json:"mergeNeedsOwner,omitempty"`
}

type Initiative string

const (
	Passive Initiative = "passive"
	Normal  Initiative = "normal"
	Eager   Initiative = "eager"
)

func (s Settings) ReviewRequired() bool { return s.Review == nil || *s.Review }

func (m Member) Can(role Role) bool {
	if m.Kind != MemberHuman {
		return false
	}
	ranks := map[Role]int{RoleApprover: 1, RoleAdmin: 2, RoleOwner: 3}
	return ranks[role] > 0 && ranks[m.Role] >= ranks[role]
}
