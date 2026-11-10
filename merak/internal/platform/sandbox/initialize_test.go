package sandbox_test

import (
	"context"
	"errors"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"testing"
)

func TestCancelledInitializationDoesNotStartASetupProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := sandbox.Initialize(ctx, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}
