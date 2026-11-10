package credential_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
)

func TestCredentialsSurviveReopeningAndLogoutRemovesThem(t *testing.T) {
	for _, fileOnly := range []bool{false, true} {
		name := "system"
		if fileOnly {
			name = "file"
		}
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			open := func() *credential.Store {
				if fileOnly {
					return credential.NewFile(directory)
				}
				return credential.New(directory)
			}
			storage := open()
			t.Cleanup(func() { _ = storage.Delete(context.Background(), "cloud") })
			if err := storage.Set(t.Context(), "cloud", []byte("fixture-token")); err != nil {
				t.Fatal(err)
			}
			value, err := open().Get(t.Context(), "cloud")
			if err != nil || !bytes.Equal(value, []byte("fixture-token")) {
				t.Fatalf("read failed: %v", err)
			}
			if err = storage.Set(t.Context(), "cloud", []byte("replacement-token")); err != nil {
				t.Fatal(err)
			}
			value, err = open().Get(t.Context(), "cloud")
			if err != nil || !bytes.Equal(value, []byte("replacement-token")) {
				t.Fatalf("replacement failed: %v", err)
			}
			if err = storage.Delete(t.Context(), "cloud"); err != nil {
				t.Fatal(err)
			}
			if _, err = open().Get(t.Context(), "cloud"); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("logout=%v", err)
			}
		})
	}
}
