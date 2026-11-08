package workspace_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestQueueSerializesEachProjectAndSkipsCancelledRequests(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var queue workspace.Queue
	var mu sync.Mutex
	var order []string
	first, release := make(chan struct{}), make(chan struct{})
	results := make(chan error, 4)
	go func() {
		results <- queue.Do(ctx, "project", func(context.Context) error {
			close(first)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			mu.Lock()
			order = append(order, "first")
			mu.Unlock()
			return nil
		})
	}()
	<-first
	withdrawn, withdraw := context.WithCancel(ctx)
	withdraw()
	if err := queue.Do(withdrawn, "project", func(context.Context) error { t.Error("cancelled operation ran"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
	second := make(chan struct{})
	go func() {
		results <- queue.Do(ctx, "project", func(context.Context) error {
			close(second)
			mu.Lock()
			order = append(order, "second")
			mu.Unlock()
			return nil
		})
	}()
	if err := queue.Do(ctx, "other-project", func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	select {
	case <-second:
		t.Fatal("same project integrations overlapped")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if !reflect.DeepEqual(order, []string{"first", "second"}) {
		t.Fatalf("order=%v", order)
	}
}
