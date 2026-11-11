package server_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/plan"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestPlanMethodsGetSaveExecuteAndStopAndPlanTrueAsksForAPlan(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var first string
	provider := fake.New(t,
		fake.Reply{Calls: []model.ToolCall{{ID: "p", Name: "write_plan", Input: []byte(`{"content":"# Plan\n1. Do it"}`)}}, Expect: func(req model.Request) error {
			for _, part := range req.Messages[len(req.Messages)-1].Parts {
				first += part.Text + "\n"
			}
			return nil
		}},
		fake.Reply{Text: "Working on the plan."},
	)
	home := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: home, Provider: "fake", Mode: permission.ModeAsk}, &created); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Plan: true, Parts: []model.Part{{Text: "Rework the parser"}}}, nil); err != nil {
		t.Fatal(err)
	}
	var got plan.Plan
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := client.Call(ctx, "plan.get", protocol.PlanParams{Session: created.Session}, &got); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got.Status != plan.Review || got.Revision != 1 || !strings.Contains(first, "write_plan") || !strings.Contains(first, "Rework the parser") {
		t.Fatalf("plan=%+v first=%q", got, first)
	}

	var failure *protocol.Error
	err = client.Call(ctx, "plan.save", protocol.PlanSaveParams{Session: created.Session, Content: "Edited", Revision: 0}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4011" {
		t.Fatalf("a stale save: %v", err)
	}
	var saved plan.Plan
	if err := client.Call(ctx, "plan.save", protocol.PlanSaveParams{Session: created.Session, Content: "# Plan\n1. Do it better", Revision: 1}, &saved); err != nil || saved.Revision != 2 {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	var executing plan.Plan
	if err := client.Call(ctx, "plan.execute", protocol.PlanParams{Session: created.Session}, &executing); err != nil || executing.Status != plan.Executing || executing.Snapshot != "# Plan\n1. Do it better" {
		t.Fatalf("executing=%+v err=%v", executing, err)
	}
	var stopped plan.Plan
	if err := client.Call(ctx, "plan.stop", protocol.PlanParams{Session: created.Session}, &stopped); err != nil || stopped.Status != plan.Stopped {
		t.Fatalf("stopped=%+v err=%v", stopped, err)
	}
	err = client.Call(ctx, "plan.stop", protocol.PlanParams{Session: created.Session}, nil)
	if !errors.As(err, &failure) || failure.Data.Code != "MRK-4012" {
		t.Fatalf("stopping twice: %v", err)
	}
}
