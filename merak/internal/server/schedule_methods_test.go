package server_test

import (
	"context"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/schedule"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestScheduleMethodsListWithNextRunsAndDeleteAndNoticesGoToTheConnectionsPerson(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	home := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: home, ScheduleInterval: time.Hour, Providers: map[string]model.Provider{"fake": fake.New(t)}})
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
	created, err := e.CreateSchedule(ctx, "0 9 * * *", "Check the deployment", "", home)
	if err != nil {
		t.Fatal(err)
	}
	if created.Owner != client.Hello.Human {
		t.Fatalf("a schedule belongs to %q but the connection acts as %q: its notices would reach nobody", created.Owner, client.Hello.Human)
	}
	var listed []schedule.Schedule
	if err := client.Call(ctx, "schedule.list", struct{}{}, &listed); err != nil || len(listed) != 1 || listed[0].ID != created.ID || listed[0].Next.IsZero() {
		t.Fatalf("listed = %+v, err = %v", listed, err)
	}
	if err := client.Call(ctx, "schedule.delete", protocol.ScheduleDeleteParams{ID: "nothing"}, nil); err == nil {
		t.Fatal("an unknown schedule was deleted")
	} else if failure, ok := err.(*protocol.Error); !ok || failure.Data.Code != "MRK-4014" {
		t.Fatalf("error = %v, want MRK-4014", err)
	}
	if err := client.Call(ctx, "schedule.delete", protocol.ScheduleDeleteParams{ID: created.ID}, nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "schedule.list", struct{}{}, &listed); err != nil || len(listed) != 0 {
		t.Fatalf("listed after the delete = %+v, err = %v", listed, err)
	}
}
