package sandbox

import (
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
)

func (p Profile) Validate() error {
	for _, paths := range [][]string{p.ReadDeny, p.WriteAllow, p.Protect} {
		for _, path := range paths {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, '\x00') {
				return errors.New("sandbox paths must be clean absolute paths")
			}
			if !resolvedPath(path) {
				return errors.New("sandbox paths must resolve symbolic links before use")
			}
		}
	}
	for _, name := range p.EnvAllow {
		if name == "" || strings.ContainsAny(name, "=\x00") {
			return errors.New("invalid sandbox environment variable name")
		}
	}
	return p.Network.Validate()
}

func resolvedPath(path string) bool {
	ancestor := path
	for {
		resolved, err := filepath.EvalSymlinks(ancestor)
		if err == nil {
			return resolved == ancestor
		}
		if !os.IsNotExist(err) {
			return false
		}
		if info, statErr := os.Lstat(ancestor); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return false
		}
		ancestor = parent
	}
}

func (n Network) Validate() error {
	if n.Mode != "" && n.Mode != "off" && n.Mode != "allowlist" && n.Mode != "on" {
		return errors.New("invalid sandbox network mode")
	}
	for _, ports := range [][]int{n.LocalPorts, n.BlockedPorts} {
		for _, port := range ports {
			if port < 1 || port > 65535 {
				return errors.New("invalid sandbox network port")
			}
		}
	}
	for _, host := range n.Hosts {
		if !validHost(host) {
			return errors.New("sandbox hosts must be exact hostnames or IP addresses")
		}
	}
	return nil
}

func validHost(host string) bool {
	if address, err := netip.ParseAddr(host); err == nil {
		return address.Zone() == ""
	}
	host = normalizeHost(host)
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '-') {
				return false
			}
		}
	}
	return true
}
