package window_test

import (
	"testing"

	"github.com/TongTong313/merakcode/merak/testkit/testmodel"
)

func TestMain(m *testing.M) {
	testmodel.Isolate()
	m.Run()
}
