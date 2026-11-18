package coordinator

import (
	"context"
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/kit"
	"github.com/TongTong313/merakcode/merak/engine/collab/leader"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/worker"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Coordinator) leaderMCPServer(g *groupRun, thread *leader.Thread, finish func(string)) *mcp.Server {
	return &mcp.Server{Tools: tool.NewPool("leader.group", domain.leaderTools(g, thread, finish)...), Env: tool.Env{Member: thread.Leader, Scope: thread.Session.Read().Scope, Workdir: g.configuration().Project.Directory, MemoryOwners: domain.roster.MemberMemoryOwners(domain.core.Ctx, g.configuration().Project.Directory, thread.Session.Read().Scope, thread.Leader)}}
}

func (domain *Coordinator) WorkerTools(a worker.Assignment, submit func(context.Context, task.Report) error) []tool.Tool {
	return []tool.Tool{
		domain.remote.GroupLookup(a.Scope.Group),
		domain.remote.ReadGroupDoc(a.Scope.Group),
		domain.gate.Wrap(tool.Remember{Memory: domain.notes}),
		domain.gate.Wrap(tool.Recall{Memory: domain.notes}),
		domain.askLeaderTool(a),
		tool.AskUser{Bus: domain.core.Bus, Ask: domain.askQuestion},
		kit.SubmitReport{Claim: a.Claim.ID, Submit: submit},
		kit.ClaimTask{Claim: func(ctx context.Context, id event.ID, scope []string) (task.Claim, error) {
			return domain.tasks.Claim(ctx, id, a.Scope.Group, a.Claim.Member, scope)
		}},
		kit.ReportProgress{Report: func(ctx context.Context, summary string) error {
			body, _ := json.Marshal(task.Progress{Claim: a.Claim.ID, Summary: summary})
			_, err := domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + a.Scope.Group), Scope: a.Scope, Type: task.Progressed, Actor: event.Actor{Kind: event.ActorAgent, ID: a.Claim.Member}, Payload: body})
			return err
		}},
	}
}
