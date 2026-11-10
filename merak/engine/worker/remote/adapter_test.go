package remote_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/remote"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestUnsupportedSteeringDoesNotInterruptTheRemoteRun(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	runner := remote.Runner{Bus: event.NewBus(memory.New(), time.Now, event.NewID), Credentials: func(ctx context.Context) (protocol.RemoteConnectParams, error) {
		<-ctx.Done()
		return protocol.RemoteConnectParams{}, ctx.Err()
	}}
	run, err := runner.Start(ctx, worker.Assignment{Session: "session", Scope: event.Scope{Group: "group", Task: "task"}, Claim: task.Claim{ID: "claim"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := run.Send(ctx, loop.Input{}); !errors.Is(err, worker.ErrUnsupported) {
		t.Fatalf("unsupported Send returned %v", err)
	}
	wait, stop := context.WithTimeout(ctx, 20*time.Millisecond)
	defer stop()
	if _, err := run.Wait(wait); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Send interrupted the run: %v", err)
	}
	if err := run.Cancel(ctx); err != nil {
		t.Fatal(err)
	}
}
