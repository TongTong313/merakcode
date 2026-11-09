package sandbox_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestProfileRejectsAmbiguousPathsAndInvalidNetworkOrEnvironmentRules(t *testing.T) {
	root := t.TempDir()
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		profile sandbox.Profile
		valid   bool
	}{
		{"accepts resolved absolute paths", sandbox.Profile{ReadDeny: []string{filepath.Join(root, ".ssh")}, WriteAllow: []string{root}, Protect: []string{filepath.Join(root, ".git", "hooks")}, Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com"}, LocalPorts: []int{1234}}, EnvAllow: []string{"PATH"}}, true},
		{"rejects relative read denials", sandbox.Profile{ReadDeny: []string{".ssh"}}, false},
		{"rejects relative write permissions", sandbox.Profile{WriteAllow: []string{"."}}, false},
		{"rejects relative protection", sandbox.Profile{Protect: []string{".git/hooks"}}, false},
		{"rejects NUL in paths", sandbox.Profile{Protect: []string{root + "\x00"}}, false},
		{"rejects traversal in paths", sandbox.Profile{WriteAllow: []string{root + string(filepath.Separator) + ".."}}, false},
		{"rejects an unknown network mode", sandbox.Profile{Network: sandbox.Network{Mode: "sometimes"}}, false},
		{"rejects URLs as hosts", sandbox.Profile{Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"https://example.com"}}}, false},
		{"accepts subdomain wildcards", sandbox.Profile{Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"*.example.com"}}}, true},
		{"rejects hosts with whitespace", sandbox.Profile{Network: sandbox.Network{Mode: "allowlist", Hosts: []string{"example.com "}}}, false},
		{"rejects an invalid local port", sandbox.Profile{Network: sandbox.Network{LocalPorts: []int{0}}}, false},
		{"rejects an invalid blocked port", sandbox.Profile{Network: sandbox.Network{BlockedPorts: []int{65536}}}, false},
		{"rejects an empty variable name", sandbox.Profile{EnvAllow: []string{""}}, false},
		{"rejects assignments as variable names", sandbox.Profile{EnvAllow: []string{"SECRET=value"}}, false},
		{"rejects NUL in variable names", sandbox.Profile{EnvAllow: []string{"PATH\x00"}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.profile.Validate(); (err == nil) != test.valid {
				t.Fatalf("profile valid = %t, want %t, error %v", err == nil, test.valid, err)
			}
		})
	}
}

func TestProfileRejectsSymlinkAliasesIncludingMissingChildren(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "actual")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	for _, test := range []struct {
		name    string
		profile sandbox.Profile
	}{
		{"existing read denial alias", sandbox.Profile{ReadDeny: []string{alias}}},
		{"existing write permission alias", sandbox.Profile{WriteAllow: []string{alias}}},
		{"missing protected child under an alias", sandbox.Profile{Protect: []string{filepath.Join(alias, "merakcode.json")}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.profile.Validate(); err == nil {
				t.Fatal("accepted an unresolved symlink alias")
			}
		})
	}
}
