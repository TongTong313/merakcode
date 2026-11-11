package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/profile"
)

type ProfileListParams struct {
}

type ProfileDeleteParams struct {
	Profile event.ID `json:"profile"`
}

type ProfileSaveParams struct {
	Profile profile.Profile `json:"profile"`
}

type MemberRegisterParams struct {
	Group  event.ID     `json:"group"`
	Member group.Member `json:"member"`
}
