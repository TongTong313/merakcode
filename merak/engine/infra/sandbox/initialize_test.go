package sandbox_test

import (
	"context"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/infra/sandbox"
	"os"
	"testing"
)

func TestCancelledInitializationDoesNotStartASetupProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := sandbox.Initialize(ctx, t.TempDir(), os.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
}
