package merak

import (
	"regexp"
	"testing"
)

func TestVersion(t *testing.T) {
	valid := regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-z]+\.(0|[1-9]\d*))?$`)
	if version := Version(); !valid.MatchString(version) {
		t.Fatalf("Version() = %q, want x.y.z or x.y.z-name.n", version)
	}
}
