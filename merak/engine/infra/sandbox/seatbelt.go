package sandbox

import (
	"fmt"
	"path"
	"slices"
	"strconv"
	"strings"
)

// seatbeltPolicy receives resolved paths; Protect contains only existing paths.
func seatbeltPolicy(p Profile, proxyPort int) string {
	var text strings.Builder
	text.WriteString("(version 1)\n(allow default)\n(deny file-write*)\n(deny network*)\n")
	text.WriteString("(allow file-write-data (literal \"/dev/null\"))\n")
	for _, location := range p.WriteAllow {
		fmt.Fprintf(&text, "(allow file-write* (subpath %s))\n", strconv.Quote(location))
	}
	for _, location := range p.ReadDeny {
		fmt.Fprintf(&text, "(deny file-read* (subpath %s))\n", strconv.Quote(location))
		seatbeltPin(&text, location)
	}
	if p.PrivateDirectory != "" {
		fmt.Fprintf(&text, "(allow file-read* file-write* (subpath %s))\n", strconv.Quote(p.PrivateDirectory))
	}
	for _, location := range p.Protect {
		fmt.Fprintf(&text, "(deny file-write* (subpath %s))\n", strconv.Quote(location))
		seatbeltPin(&text, location)
	}
	if proxyPort > 0 {
		fmt.Fprintf(&text, "(allow network-outbound (remote ip \"localhost:%d\"))\n", proxyPort)
	}
	for _, port := range p.Network.LocalPorts {
		if slices.Contains(p.Network.BlockedPorts, port) {
			continue
		}
		fmt.Fprintf(&text, "(allow network-outbound (remote ip \"localhost:%d\"))\n", port)
	}
	return text.String()
}

func seatbeltPin(text *strings.Builder, location string) {
	fmt.Fprintf(text, "(deny file-write-unlink (subpath %s))\n", strconv.Quote(location))
	for parent := path.Dir(location); parent != "/" && parent != "."; parent = path.Dir(parent) {
		fmt.Fprintf(text, "(deny file-write-unlink (literal %s))\n", strconv.Quote(parent))
	}
}
