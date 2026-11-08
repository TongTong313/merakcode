package tool_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

func TestSubmitReportExplainsTheLimitAndKeepsTheClaimActive(t *testing.T) {
	ctx := context.Background()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Project", Project: group.Project{Directory: t.TempDir()}, DefaultLeader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
	})
	if err != nil {
		t.Fatal(err)
	}
	pool := task.New(storage, bus, event.NewID, groups)
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Verify"})
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Open(ctx, card.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Assign(ctx, card.ID, "worker", task.RoleOwner, nil); err != nil {
		t.Fatal(err)
	}
	claim, err := pool.Next(ctx, "worker")
	if err != nil {
		t.Fatal(err)
	}
	operation := tool.SubmitReport{Claim: claim.ID, Submit: pool.Submit}
	body, _ := json.Marshal(map[string]string{"verdict": "done", "summary": strings.Repeat("Ω", 1201)})
	result, err := operation.Run(ctx, tool.Call{Input: body})
	if err != nil || !result.IsError || !strings.Contains(result.Parts[0].Text, "1200") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	active, _ := pool.Get(ctx, card.ID)
	if active.Status != task.Running || active.Claims[0].Report != nil {
		t.Fatalf("claim changed after rejection: %+v", active)
	}
	for _, path := range []string{"", "../outside", "/absolute", "C:/external", "file\x00"} {
		body, _ := json.Marshal(map[string]any{"verdict": "done", "summary": "Ready", "artifacts": []task.Artifact{{Path: path}}})
		result, err := operation.Run(ctx, tool.Call{Input: body})
		if err != nil || !result.IsError || !strings.Contains(result.Parts[0].Text, "relative") {
			t.Fatalf("artifact path=%q result=%+v err=%v", path, result, err)
		}
	}
	for _, tc := range []struct {
		name   string
		field  string
		value  any
		reason string
	}{
		{"too many questions", "questions", []string{"one", "two", "three", "four", "five", "six"}, "5"},
		{"too many next steps", "next", []string{"one", "two", "three", "four", "five", "six"}, "5"},
		{"negative change count", "changes", []map[string]any{{"path": "README.md", "kind": "modified", "added": -1, "removed": 0}}, "nonnegative"},
		{"outside change path", "changes", []map[string]any{{"path": "../outside", "kind": "modified", "added": 1, "removed": 0}}, "relative"},
		{"empty check command", "checks", []map[string]any{{"command": " ", "exitCode": 0}}, "command"},
		{"missing check exit code", "checks", []map[string]any{{"command": "go test ./..."}}, "exitCode"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{"verdict": "done", "summary": "Ready", tc.field: tc.value})
			result, err := operation.Run(ctx, tool.Call{Input: body})
			if err != nil || !result.IsError || !strings.Contains(result.Parts[0].Text, tc.reason) {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			active, err := pool.Get(ctx, card.ID)
			if err != nil || active.Status != task.Running || active.Claims[0].Report != nil {
				t.Fatalf("rejected report changed the claim: %+v %v", active, err)
			}
		})
	}
	body, _ = json.Marshal(map[string]string{"verdict": "done", "summary": strings.Repeat("Ω", 1200)})
	result, err = operation.Run(ctx, tool.Call{Input: body})
	if err != nil || result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	finished, _ := pool.Get(ctx, card.ID)
	if finished.Status != task.Review || len([]rune(finished.Claims[0].Report.Summary)) != 1200 {
		t.Fatalf("card=%+v", finished)
	}
}
