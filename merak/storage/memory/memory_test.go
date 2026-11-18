package memory_test

import (
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/storetest"
	"testing"
)

func TestStore(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return memory.New() })
}
