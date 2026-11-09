package engine_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestSessionPermissionModeControlsApprovalIndependently(t *testing.T) {
	dir := t.TempDir()
	var replies []fake.Reply
	for _, name := range []string{"takeover.txt", "ask.txt"} {
		input, _ := json.Marshal(map[string]string{"path": name, "content": "approved"})
		replies = append(replies, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: input}}}, fake.Reply{Text: "Finished"})
	}
	provider := fake.New(t, replies...)
	var approvals atomic.Int32
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		approvals.Add(1)
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var sessions []event.ID
	modes := []permission.Mode{permission.ModeTakeover, permission.ModeAsk}
	for _, mode := range modes {
		id, err := e.CreateSession(ctx, engine.SessionOptions{Provider: "fixture", Mode: mode})
		if err != nil {
			t.Fatal(err)
		}
		sessions = append(sessions, id)
	}
	for index, mode := range modes {
		t.Run(string(mode), func(t *testing.T) {
			id := sessions[index]
			events, stop := e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}})
			defer stop()
			if err := e.Send(ctx, id, []model.Part{{Text: "Write the file"}}); err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case fact, open := <-events:
					if !open {
						t.Fatal("session ended without turn.finished")
					}
					if fact.Type != loop.TurnFinished {
						continue
					}
					body, err := os.ReadFile(filepath.Join(dir, string(mode)+".txt"))
					if mode == permission.ModeTakeover {
						if approvals.Load() != 0 || err != nil || string(body) != "approved" {
							t.Fatalf("takeover approvals=%d file=%q error=%v", approvals.Load(), body, err)
						}
						return
					}
					if approvals.Load() != 1 || !os.IsNotExist(err) {
						t.Fatalf("ask approvals=%d file error=%v", approvals.Load(), err)
					}
					return
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}

func TestSessionRejectsAnUnknownPermissionMode(t *testing.T) {
	e, err := engine.New(engine.Deps{Workdir: t.TempDir(), Providers: map[string]model.Provider{"fixture": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(context.Background(), engine.SessionOptions{Provider: "fixture", Mode: "sometimes"})
	if err == nil || id != "" {
		t.Fatalf("unknown mode created session %q, error %v", id, err)
	}
}

func TestBuiltinWorkerTakeoverUsesTheMemberMode(t *testing.T) {
	dir := t.TempDir()
	input, _ := json.Marshal(map[string]string{"path": "member.txt", "content": "member output"})
	provider := fake.New(t, fake.Reply{Calls: []model.ToolCall{{ID: "write", Name: "write_file", Input: input}}}, fake.Reply{Text: "Finished"})
	var approvals atomic.Int32
	e, err := engine.New(engine.Deps{Providers: map[string]model.Provider{"fixture": provider}, Ask: func(context.Context, permission.Request) (permission.Reply, error) {
		approvals.Add(1)
		return permission.Reply{Decision: permission.Deny}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := profile.DefaultWorker()
	p.Model.Provider, p.Mode = "fixture", permission.ModeTakeover
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run, err := e.StartWorker(ctx, p, worker.Assignment{Session: "member", Workdir: dir, Packet: "Write the file"})
	if err != nil {
		t.Fatal(err)
	}
	report, runErr := run.Wait(ctx)
	body, readErr := os.ReadFile(filepath.Join(dir, "member.txt"))
	if runErr != nil || report.Verdict != task.VerdictDone || approvals.Load() != 0 || readErr != nil || string(body) != "member output" {
		t.Fatalf("member report=%+v error=%v approvals=%d file=%q error=%v", report, runErr, approvals.Load(), body, readErr)
	}
}
