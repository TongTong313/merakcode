package claudecode_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/storage/memory"
)

func TestExternalWorkerReworkResumesItsProductConversation(t *testing.T) {
	binary := fakeBinary(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	dir := t.TempDir()
	for _, packet := range []string{"Original instructions", "Review feedback"} {
		runner := &claudecode.Runner{Bus: bus, Store: storage, Product: definition.Product{Binary: binary, Args: []string{"--history"}}}
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
