package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
)

type ProfileListParams struct {
	Human event.ID `json:"human"`
}

type ProfileSaveParams struct {
	Human   event.ID        `json:"human"`
	Profile profile.Profile `json:"profile"`
}

type MemberRegisterParams struct {
	Group  event.ID     `json:"group"`
	Human  event.ID     `json:"human"`
	Member group.Member `json:"member"`
}
