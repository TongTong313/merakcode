package server_test

import (
	"slices"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol/schema"
)

func TestEveryProtocolMethodHasOneHandlerAndNothingElseIsHandled(t *testing.T) {
	var want []string
	for _, method := range schema.Methods() {
		if method.Name == "hello" {
			continue
		}
		want = append(want, method.Name)
	}
	slices.Sort(want)
	got := server.HandledMethods()
	if !slices.Equal(got, want) {
		for _, name := range want {
			if !slices.Contains(got, name) {
				t.Errorf("no handler for %s", name)
			}
		}
		for _, name := range got {
			if !slices.Contains(want, name) {
				t.Errorf("%s is handled but is not in the protocol", name)
			}
		}
	}
}
