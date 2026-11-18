package enginetest

import (
	"context"
	"testing"
	"time"
)

func WaitFor(t *testing.T, ctx context.Context, what string, ok func() bool) {
	t.Helper()
	for !ok() {
		select {
		case <-time.After(5 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}
