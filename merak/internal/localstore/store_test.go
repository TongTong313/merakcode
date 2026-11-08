package localstore_test

import (
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/storetest"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	"path/filepath"
	"testing"
)

func TestStoreContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		s, err := localstore.Open(filepath.Join(t.TempDir(), "merak.db"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { s.Close() })
		return s
	})
}
