package sandbox

import (
	"reflect"
	"testing"
)

func TestLandlockPlansPathsAndABICapabilities(t *testing.T) {
	p := Profile{WriteAllow: []string{"/work", "/config", "/engine/member"}, ReadDeny: []string{"/home/user/.ssh", "/engine"}, PrivateDirectory: "/engine/member", Protect: []string{"/work/hooks"}, Network: Network{Mode: "allowlist"}}
	nodes := []landlockNode{{"/", true}, {"/home", true}, {"/home/user", true}, {"/home/user/.ssh", true}, {"/home/user/.ssh/key", false}, {"/home/user/project", true}, {"/work", true}, {"/config", false}, {"/engine", true}, {"/engine/member", true}}
	for _, test := range []struct {
		name                              string
		abi                               int
		handled, directory, file, network uint64
	}{
		{"ABI 1", 1, 8191, 8191, 7, 0},
		{"ABI 2", 2, 16383, 16383, 7, 0},
		{"ABI 3", 3, 32767, 32767, 16391, 0},
		{"ABI 4", 4, 32767, 32767, 16391, 3},
		{"newer ABI", 8, 32767, 32767, 16391, 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan := planLandlock(p, test.abi, 8123, nodes)
			want := []landlockPathRule{{"/config", test.file}, {"/engine/member", test.directory}, {"/home/user/project", 13}, {"/work", test.directory}}
			if plan.HandledFS != test.handled || plan.HandledNet != test.network || !reflect.DeepEqual(plan.Paths, want) {
				t.Fatalf("ABI=%d write=%v denied=%v private=%s proxy=8123: plan=%+v expected paths=%+v", test.abi, p.WriteAllow, p.ReadDeny, p.PrivateDirectory, plan, want)
			}
			if test.network == 0 && len(plan.ConnectPorts) != 0 || test.network != 0 && !reflect.DeepEqual(plan.ConnectPorts, []int{8123}) {
				t.Fatalf("unexpected proxy ports: %+v", plan)
			}
		})
	}
}

func TestLandlockNetworkOffDoesNotOpenAnyPort(t *testing.T) {
	plan := planLandlock(Profile{Network: Network{Mode: "off"}}, 4, 0, nil)
	if plan.HandledNet != 3 || len(plan.ConnectPorts) != 0 {
		t.Fatalf("network off plan=%+v", plan)
	}
	if plan.HandledFS != 32754 || len(plan.Paths) != 0 {
		t.Fatalf("unexpected file grants: %+v", plan)
	}
}

func TestLandlockAllowsTheNullDeviceWithoutOpeningOtherDevices(t *testing.T) {
	plan := planLandlock(Profile{}, 4, 0, []landlockNode{{"/dev/null", false}, {"/dev/mem", false}})
	if !reflect.DeepEqual(plan.Paths, []landlockPathRule{{"/dev/null", 2}}) {
		t.Fatalf("null device grant: %+v", plan.Paths)
	}
}
