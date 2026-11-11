package permission_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/store/memory"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/workspace"
)

func TestRoutineWorkerApprovalReachesLeaderEvenWithOnlineApprover(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	storage := memory.New()
	bus := event.NewBus(storage, time.Now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	pool := task.New(storage, bus, event.NewID, groups)
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal"})
	if err != nil {
		t.Fatal(err)
	}
	human := make(chan permission.Request, 1)
	router := &permission.Router{Bus: bus, Groups: groups, Tasks: pool, Human: func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		human <- req
		return permission.Reply{Decision: permission.Allow, Human: "approver"}, nil
	}}
	facts, stop := bus.Subscribe(event.Filter{Types: []event.Type{permission.Routed}})
	defer stop()
	result := make(chan permission.Reply, 1)
	go func() {
		reply, err := router.Ask(ctx, permission.Request{Member: "worker", Mode: permission.ModeAuto, Spec: tool.Spec{Name: "bash", Effect: tool.EffectExec}, Call: tool.Call{Input: json.RawMessage(`{"command":"custom-check"}`), Env: tool.Env{Workdir: g.Project.Directory, Scope: event.Scope{Group: g.ID, Task: card.ID, Session: "worker-chat"}}}})
		if err != nil {
			t.Error(err)
		}
		result <- reply
	}()
	select {
	case fact := <-facts:
		req, err := event.Decode[permission.Request](fact)
		if err != nil || req.Leader != "leader" {
			t.Fatalf("request=%+v err=%v", req, err)
		}
		if err := router.Approve(ctx, req.ID, g.ID, g.ID, "leader", permission.Allow); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("Leader did not receive approval")
	}
	select {
	case reply := <-result:
		if reply.Decision != permission.Allow || reply.Leader != "leader" {
			t.Fatalf("reply=%+v", reply)
		}
	case <-ctx.Done():
		t.Fatal("approval did not finish")
	}
	select {
	case <-human:
		t.Fatal("routine approval reached a human before the Leader")
	default:
	}
}

func TestOnlyRoutineWorkerRequestsMayBeAnsweredByTheLeader(t *testing.T) {
	for _, tc := range []struct {
		name, kind, member string
		effect             tool.Effect
		path               string
		mode               permission.Mode
	}{
		{"outside write", "", "worker", tool.EffectWrite, "../outside.txt", permission.ModeAuto},
		{"budget", "budget", "worker", tool.EffectGroup, "", permission.ModeAuto},
		{"review", "review", "worker", tool.EffectGroup, "", permission.ModeAuto},
		{"plan confirmation", "plan", "worker", tool.EffectGroup, "", permission.ModeAuto},
		{"workspace configuration", "workspace", "worker", tool.EffectExec, "", permission.ModeAuto},
		{"Leader request", "", "leader", tool.EffectExec, "", permission.ModeAuto},
		{"ask mode", "", "worker", tool.EffectExec, "", permission.ModeAsk},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			router, storage, card, directory := routingTeam(t)
			router.Human = func(ctx context.Context, req permission.Request) (permission.Reply, error) {
				if req.Leader != "" {
					t.Fatal("human request was delegated")
				}
				if err := router.Approve(ctx, req.ID, card.Group, card.Group, "leader", permission.Allow); err == nil {
					t.Fatal("Leader approved a human-only request")
				}
				return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
			}
			reply, err := router.Ask(ctx, permission.Request{Kind: tc.kind, Member: event.ID(tc.member), Mode: tc.mode, Path: tc.path, Spec: tool.Spec{Name: "operation", Effect: tc.effect}, Call: tool.Call{Env: tool.Env{Workdir: directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: "chat"}}}})
			if err != nil || reply.Decision != permission.Allow || reply.Human != "owner" {
				t.Fatalf("reply=%+v err=%v", reply, err)
			}
			facts, err := storage.Find(ctx, store.Query{Types: []event.Type{permission.Routed}})
			if err != nil || len(facts) != 0 {
				t.Fatalf("Leader routes=%v err=%v", facts, err)
			}
		})
	}
}

func TestWorkspaceConfirmationHasNoTaskOrApprovalDeadline(t *testing.T) {
	router, _, card, directory := routingTeam(t)
	router.Timeout = 10 * time.Millisecond
	router.Human = func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		if req.Call.Env.Scope.Task != "" || req.Leader != "" {
			t.Errorf("workspace request retained a task or Leader: %+v", req)
		}
		if permission.Need(req, workspace.Workspace{}, group.Group{}) != group.RoleAdmin {
			t.Error("workspace request did not require admin")
		}
		select {
		case <-time.After(40 * time.Millisecond):
			return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}
	reply, err := router.Ask(t.Context(), permission.Request{Kind: "workspace", Member: "worker", Mode: permission.ModeAuto, Spec: tool.Spec{Name: "workspace_mcp", Effect: tool.EffectExec}, Call: tool.Call{Env: tool.Env{Workdir: directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: "session"}}}})
	if err != nil || reply.Decision != permission.Allow {
		t.Fatalf("reply=%+v err=%v", reply, err)
	}
	updated, err := router.Tasks.Get(t.Context(), card.ID)
	if err != nil || updated.Status == task.Blocked {
		t.Fatalf("task=%+v err=%v", updated, err)
	}
}

func TestEscalationKeepsTheOriginalDeadlineAndTimeoutBlocksTheTask(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	router, storage, card, directory := routingTeam(t)
	if _, err := router.Tasks.OpenAndAssign(ctx, card.ID, "worker"); err != nil {
		t.Fatal(err)
	}
	claim, err := router.Tasks.Next(ctx, "worker")
	if err != nil {
		t.Fatal(err)
	}
	router.Timeout = 150 * time.Millisecond
	router.Human = func(ctx context.Context, req permission.Request) (permission.Reply, error) {
		deadline, ok := ctx.Deadline()
		fact, err := storage.Get(ctx, req.ID)
		if err != nil || !ok || deadline.Sub(fact.Time) > router.Timeout+20*time.Millisecond {
			t.Errorf("deadline reset: %v %v", deadline, err)
		}
		<-ctx.Done()
		return permission.Reply{}, ctx.Err()
	}
	facts, stop := router.Bus.Subscribe(event.Filter{Types: []event.Type{permission.Routed}})
	defer stop()
	result := make(chan error, 1)
	go func() {
		_, err := router.Ask(ctx, permission.Request{Member: "worker", Mode: permission.ModeAuto, Spec: tool.Spec{Name: "bash", Effect: tool.EffectExec}, Call: tool.Call{Env: tool.Env{Workdir: directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: "chat"}}}})
		result <- err
	}()
	select {
	case fact := <-facts:
		req, err := event.Decode[permission.Request](fact)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(60 * time.Millisecond)
		if err := router.Approve(ctx, req.ID, card.Group, "another-task", "leader", permission.Allow); err == nil {
			t.Fatal("another task approved the request")
		}
		if err := router.Escalate(ctx, req.ID, card.Group, card.Group, "leader"); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("Leader did not receive request")
	}
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("timeout=%v", err)
		}
	case <-ctx.Done():
		t.Fatal("approval did not time out")
	}
	blocked, err := router.Tasks.Get(ctx, card.ID)
	if err != nil || blocked.Status != task.Blocked {
		t.Fatalf("task=%+v err=%v", blocked, err)
	}
	notices, err := storage.Find(ctx, store.Query{Types: []event.Type{group.NoticeSent}})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, fact := range notices {
		notice, err := event.Decode[group.Notice](fact)
		if err != nil {
			t.Fatal(err)
		}
		if notice.Kind == "blocked" && len(notice.To) == 1 && notice.To[0] == "owner" {
			found = true
		}
	}
	if !found {
		t.Fatal("timeout did not notify owner")
	}
	if err := router.Tasks.Submit(ctx, task.Report{Claim: claim.ID, Verdict: task.VerdictDone, Summary: "Late report"}); err != nil {
		t.Fatal(err)
	}
	blocked, err = router.Tasks.Get(ctx, card.ID)
	if err != nil || blocked.Status != task.Blocked {
		t.Fatalf("late report cleared timeout: %+v %v", blocked, err)
	}
}

func TestTimelyAnswerDoesNotTimeOutWhileItsReplyIsPersisted(t *testing.T) {
	var slow atomic.Bool
	router, _, card, directory := routingTeam(t, func() time.Time {
		if slow.CompareAndSwap(true, false) {
			time.Sleep(100 * time.Millisecond)
		}
		return time.Now()
	})
	router.Timeout = 50 * time.Millisecond
	router.Human = func(context.Context, permission.Request) (permission.Reply, error) {
		slow.Store(true)
		return permission.Reply{Decision: permission.Allow, Human: "owner"}, nil
	}
	reply, err := router.Ask(t.Context(), permission.Request{Member: "worker", Mode: permission.ModeAsk, Spec: tool.Spec{Name: "bash", Effect: tool.EffectExec}, Call: tool.Call{Env: tool.Env{Workdir: directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: "chat"}}}})
	if err != nil || reply.Decision != permission.Allow {
		t.Fatalf("reply=%+v err=%v", reply, err)
	}
	card, err = router.Tasks.Get(t.Context(), card.ID)
	if err != nil || card.Status == task.Blocked {
		t.Fatalf("timely answer blocked task: %+v %v", card, err)
	}
}

func TestPendingApprovalTransfersToTheNewGroupLeader(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	router, _, card, directory := routingTeam(t)
	facts, stop := router.Bus.Subscribe(event.Filter{Types: []event.Type{permission.Routed}})
	defer stop()
	result := make(chan permission.Reply, 1)
	go func() {
		reply, err := router.Ask(ctx, permission.Request{Member: "worker", Mode: permission.ModeAuto, Spec: tool.Spec{Name: "bash", Effect: tool.EffectExec}, Call: tool.Call{Env: tool.Env{Workdir: directory, Scope: event.Scope{Group: card.Group, Task: card.ID, Session: "chat"}}}})
		if err != nil {
			t.Error(err)
		}
		result <- reply
	}()
	var req permission.Request
	select {
	case fact := <-facts:
		req, _ = event.Decode[permission.Request](fact)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := router.Groups.ReplaceLeader(ctx, card.Group, "owner", group.Member{ID: "next", Name: "Next", Kind: group.MemberAgent, AgentRole: group.AgentLeader}); err != nil {
		t.Fatal(err)
	}
	if err := router.Transfer(ctx, card.Group); err != nil {
		t.Fatal(err)
	}
	select {
	case fact := <-facts:
		transferred, err := event.Decode[permission.Request](fact)
		if err != nil || transferred.Leader != "next" || transferred.ID != req.ID {
			t.Fatalf("transfer=%+v %v", transferred, err)
		}
	case <-ctx.Done():
		t.Fatal("pending request did not reach the new Leader")
	}
	if err := router.Approve(ctx, req.ID, card.Group, card.Group, "leader", permission.Allow); err == nil {
		t.Fatal("previous Leader approved after handover")
	}
	if err := router.Approve(ctx, req.ID, card.Group, card.Group, "next", permission.Allow); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-result:
		if reply.Leader != "next" {
			t.Fatalf("reply=%+v", reply)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func routingTeam(t *testing.T, clocks ...func() time.Time) (*permission.Router, *memory.Store, task.Card, string) {
	t.Helper()
	ctx := context.Background()
	storage := memory.New()
	now := time.Now
	if len(clocks) > 0 {
		now = clocks[0]
	}
	bus := event.NewBus(storage, now, event.NewID)
	groups := group.New(storage, bus, event.NewID)
	pool := task.New(storage, bus, event.NewID, groups)
	directory := t.TempDir()
	g, err := groups.Create(ctx, group.Group{Kind: group.KindLocal, Name: "Team", Project: group.Project{Directory: directory}, Leader: "leader"}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker},
		{ID: "approver", Name: "Approver", Kind: group.MemberHuman, Role: group.RoleApprover},
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
	})
	if err != nil {
		t.Fatal(err)
	}
	card, err := pool.Create(ctx, task.Card{Group: g.ID, Title: "Goal", Participants: []event.ID{"approver"}})
	if err != nil {
		t.Fatal(err)
	}
	return &permission.Router{Bus: bus, Groups: groups, Tasks: pool}, storage, card, directory
}
