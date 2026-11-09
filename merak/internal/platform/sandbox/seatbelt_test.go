package sandbox

import (
	"os"
	"strings"
	"testing"
)

func TestSeatbeltPolicyMatchesTheReviewedRules(t *testing.T) {
	for _, test := range []struct {
		name    string
		profile Profile
		proxy   int
	}{
		{"off", Profile{Network: Network{Mode: "off"}}, 0},
		{"member", Profile{WriteAllow: []string{"/work", `/Users/test/quote"name`}, ReadDeny: []string{"/Users/test/.ssh", "/engine"}, PrivateDirectory: "/engine/member-1", Protect: []string{"/work/.git/hooks"}, Network: Network{Mode: "allowlist", LocalPorts: []int{3000, 4000}, BlockedPorts: []int{4000}}}, 8123},
	} {
		t.Run(test.name, func(t *testing.T) {
			want, err := os.ReadFile("testdata/seatbelt-" + test.name + ".sb")
			if err != nil {
				t.Fatal(err)
			}
			got := seatbeltPolicy(test.profile, test.proxy)
			if got != strings.ReplaceAll(string(want), "\r\n", "\n") {
				t.Fatalf("Seatbelt profile %s differs; paths=%v, denied=%v, protected=%v, proxy=%d\nactual:\n%s\nexpected:\n%s", test.name, test.profile.WriteAllow, test.profile.ReadDeny, test.profile.Protect, test.proxy, got, want)
			}
		})
	}
}
