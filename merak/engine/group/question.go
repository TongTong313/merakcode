package group

import "github.com/TongTong313/merakcode/merak/engine/event"

const (
	MemberAsked    event.Type = "member.asked"
	MemberAnswered event.Type = "member.answered"
)

type MemberQuestion struct {
	Claim event.ID `json:"claim"`
	Text  string   `json:"text"`
}

type MemberAnswer struct {
	Member event.ID `json:"member"`
	Text   string   `json:"text"`
}

func init() {
	event.Register[MemberQuestion](MemberAsked)
	event.Register[MemberAnswer](MemberAnswered)
}
