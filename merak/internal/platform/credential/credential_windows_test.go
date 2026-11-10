package credential_test

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/credential"
	"golang.org/x/sys/windows"
)

func TestOversizedSystemCredentialUsesThePermittedFileFallback(t *testing.T) {
	directory := t.TempDir()
	storage := credential.New(directory)
	t.Cleanup(func() { _ = storage.Delete(context.Background(), "cloud") })
	want := bytes.Repeat([]byte("x"), 2561)
	if err := storage.Set(t.Context(), "cloud", want); err != nil {
		t.Fatal(err)
	}
	value, err := credential.New(directory).Get(t.Context(), "cloud")
	if err != nil || !bytes.Equal(value, want) {
		t.Fatalf("permitted fallback lost the credential: %v", err)
	}
}

func TestCredentialUpdateRemainsConsistentWhenRecordCannotBeReplaced(t *testing.T) {
	directory := t.TempDir()
	storage := credential.New(directory)
	if err := storage.Set(t.Context(), "cloud", []byte("previous")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = storage.Delete(context.Background(), "cloud") })
	files, err := filepath.Glob(filepath.Join(directory, "*.json"))
	if err != nil || len(files) != 1 {
		t.Fatalf("credential records=%v: %v", files, err)
	}
	path, err := windows.UTF16PtrFromString(files[0])
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	writeErr := storage.Set(t.Context(), "cloud", []byte("replacement"))
	value, err := storage.Get(t.Context(), "cloud")
	if err != nil {
		t.Fatal(err)
	}
	if writeErr != nil && string(value) != "previous" {
		t.Fatalf("failed update changed the credential: %v", writeErr)
	}
	if writeErr == nil && string(value) != "replacement" {
		t.Fatal("successful update did not save the replacement")
	}
}
