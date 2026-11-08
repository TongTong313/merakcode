package permission_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestApprovalEventsIdentifyTheRequestAndItsReply(t *testing.T) {
	bus := event.NewBus(nil, time.Now, event.NewID)
	events, unsubscribe := bus.Subscribe(event.Filter{})
	defer unsubscribe()
	gate := permission.Gate{
		Bus: bus, Policy: permission.Policy{Mode: permission.ModeAsk},
		Ask: func(context.Context, permission.Request) (permission.Reply, error) {
			return permission.Reply{Decision: permission.Allow}, nil
		},
	}
	_, err := gate.Wrap(markerTool{}).Run(context.Background(), tool.Call{
		ID: "write-1", Name: "write_marker",
		Env: tool.Env{Workdir: t.TempDir(), Scope: event.Scope{Session: "approval-chat", Turn: "turn-a"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	var got []event.Event
	for e := range events {
		got = append(got, e)
	}
	if len(got) != 2 || got[0].Type != "permission.requested" || got[1].Type != "permission.replied" {
		t.Fatalf("approval events = %+v", got)
	}
	if got[1].Cause != got[0].ID || got[1].Scope != got[0].Scope || got[1].Stream != "session:approval-chat" {
		t.Fatalf("reply does not identify its request: %+v", got)
	}
	reply, err := event.Decode[permission.Reply](got[1])
	if err != nil || reply.Decision != permission.Allow {
		t.Fatalf("reply payload = %+v, error = %v", reply, err)
	}
}

type markerTool struct{}

func (markerTool) Spec() tool.Spec { return tool.Spec{Name: "write_marker"} }

func (markerTool) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	if err := ctx.Err(); err != nil {
		return tool.Result{}, err
	}
	if err := os.WriteFile(filepath.Join(call.Env.Workdir, "marker.txt"), []byte("approved"), 0o600); err != nil {
		return tool.Result{}, err
	}
	return tool.Result{Parts: []model.Part{{Text: "Marker written."}}}, nil
}

func TestGateWaitsForHumanBeforeRunningTheTool(t *testing.T) {
	for _, decision := range []permission.Decision{permission.Allow, permission.Deny} {
		t.Run(string(decision), func(t *testing.T) {
			dir := t.TempDir()
			requests := make(chan permission.Request)
			answers := make(chan permission.Reply)
			gate := permission.Gate{
				Policy: permission.Policy{Mode: permission.ModeAsk},
				Ask: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
					select {
					case requests <- req:
					case <-ctx.Done():
						return permission.Reply{}, ctx.Err()
					}
					select {
					case reply := <-answers:
						return reply, nil
					case <-ctx.Done():
						return permission.Reply{}, ctx.Err()
					}
				},
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			type execution struct {
				result tool.Result
				err    error
			}
			done := make(chan execution, 1)
			go func() {
				result, err := gate.Wrap(markerTool{}).Run(ctx, tool.Call{ID: "write-1", Name: "write_marker", Env: tool.Env{Workdir: dir}})
				done <- execution{result, err}
			}()
			select {
			case req := <-requests:
				if req.Call.ID != "write-1" || req.Spec.Name != "write_marker" {
					t.Fatalf("wrong approval request: %+v", req)
				}
			case <-ctx.Done():
				t.Fatal("approval was not requested")
			}
			path := filepath.Join(dir, "marker.txt")
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("tool executed before approval: %v", err)
			}
			answers <- permission.Reply{Decision: decision}
			select {
			case got := <-done:
				if got.err != nil {
					t.Fatal(got.err)
				}
				if decision == permission.Deny {
					if !got.result.IsError || got.result.Code != "MRK-5002" {
						t.Fatalf("denial was not a tool error: %+v", got.result)
					}
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Fatal("denied tool wrote a file")
					}
					return
				}
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "approved" || got.result.IsError {
					t.Fatalf("approved tool failed: data=%q error=%v result=%+v", data, err, got.result)
				}
			case <-ctx.Done():
				t.Fatal("tool did not finish after the reply")
			}
		})
	}
}
