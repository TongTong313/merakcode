package sandbox

import (
	"cmp"
	"slices"
	"strings"
)

type landlockNode struct {
	Path      string
	Directory bool
}
type landlockPathRule struct {
	Path   string
	Access uint64
}
type landlockPlan struct {
	HandledFS, HandledNet uint64
	Paths                 []landlockPathRule
	ConnectPorts          []int
}

// The filesystem bits are defined by the stable Linux Landlock userspace ABI.
const landlockRead = uint64(1<<0 | 1<<2 | 1<<3)
const landlockWriteV1 = uint64(1<<1 | 1<<4 | 1<<5 | 1<<6 | 1<<7 | 1<<8 | 1<<9 | 1<<10 | 1<<11 | 1<<12)

func planLandlock(p Profile, abi, proxyPort int, nodes []landlockNode) landlockPlan {
	write := landlockWriteV1
	if abi >= 2 {
		write |= 1 << 13
	}
	if abi >= 3 {
		write |= 1 << 14
	}
	plan := landlockPlan{HandledFS: write}
	if len(p.ReadDeny) > 0 {
		plan.HandledFS |= landlockRead
	}
	if abi >= 4 && (proxyPort > 0 || p.Network.Mode == "" || p.Network.Mode == "off") {
		plan.HandledNet = 3
		if proxyPort > 0 {
			plan.ConnectPorts = []int{proxyPort}
		}
	}
	grants := make(map[string]uint64)
	for _, node := range nodes {
		access := uint64(0)
		if len(p.ReadDeny) > 0 && (landlockReadSelection(node.Path, p.ReadDeny) == "allow" || node.Path == p.PrivateDirectory) {
			access |= landlockRead
		}
		if slices.Contains(p.WriteAllow, node.Path) {
			access |= write
		}
		if node.Path == "/dev/null" {
			access |= 1 << 1
		}
		if !node.Directory {
			access &= 1<<0 | 1<<1 | 1<<2 | 1<<14
		}
		if access != 0 {
			grants[node.Path] |= access
		}
	}
	for path, access := range grants {
		plan.Paths = append(plan.Paths, landlockPathRule{path, access})
	}
	slices.SortFunc(plan.Paths, func(a, b landlockPathRule) int { return cmp.Compare(a.Path, b.Path) })
	return plan
}

func landlockReadSelection(location string, denied []string) string {
	ancestor := false
	for _, blocked := range denied {
		if location == blocked || strings.HasPrefix(location, strings.TrimSuffix(blocked, "/")+"/") {
			return "deny"
		}
		if strings.HasPrefix(blocked, strings.TrimSuffix(location, "/")+"/") {
			ancestor = true
		}
	}
	if ancestor {
		return "descend"
	}
	return "allow"
}
