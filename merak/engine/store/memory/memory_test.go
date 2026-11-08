package memory_test

import (
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/store/storetest"
	"testing"
)

func TestStore(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store { return memory.New() })
}
