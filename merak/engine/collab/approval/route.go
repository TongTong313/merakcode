package approval

import (
	"slices"

	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/workspace"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

// Recipients selects online participants before other online humans and offline inboxes.
func Recipients(members []group.Member, role group.Role, participants []event.ID) []event.ID {
	var eligible, online, participating []event.ID
	for _, member := range members {
		if !member.Can(role) {
			continue
		}
		eligible = append(eligible, member.ID)
		if member.Status == group.Offline {
			continue
		}
		online = append(online, member.ID)
		if slices.Contains(participants, member.ID) {
			participating = append(participating, member.ID)
		}
	}
	if len(participating) > 0 {
		return participating
	}
	if len(online) > 0 {
		return online
	}
	return eligible
}

// Need classifies an operation with the settings of the group it happens in.
func Need(req permission.Request, ws workspace.Workspace, g group.Group) group.Role {
	return permission.Need(req, ws.Directory, permission.NeedOptions{
		MergeWithoutOwner: !g.Settings.MergeApprovalRequired(),
		AllowedHosts:      g.Settings.AllowedHosts,
		DeniedHosts:       g.Settings.DeniedHosts,
	})
}
