package claudecode_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/claudecode"
)

func TestExternalWorkerReworkResumesItsProductConversation(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	dir := t.TempDir()
	for _, packet := range []string{"Original instructions", "Review feedback"} {
		runner := &claudecode.Runner{Bus: bus, Store: storage, Product: profile.Product{Binary: binary, Args: []string{"--history"}}}
		run, err := runner.Start(ctx, worker.Assignment{Session: "session", Workdir: dir, Packet: packet})
		if err != nil {
			t.Fatal(err)
		}
		report, err := run.Wait(ctx)
		if err != nil || !strings.Contains(report.Summary, "Original instructions") || !strings.Contains(report.Summary, packet) {
			t.Fatalf("report=%+v err=%v", report, err)
		}
	}
	facts, err := storage.Find(ctx, store.Query{Types: []event.Type{session.Created}})
	if err != nil || len(facts) != 1 {
		t.Fatalf("created=%d err=%v", len(facts), err)
	}
}
