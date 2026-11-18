package execution

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

type memberExecution struct{ group, member event.ID }

func (domain *Execution) MemberBusy(groupID, memberID event.ID) bool {
	domain.memberMu.Lock()
	defer domain.memberMu.Unlock()
	return domain.memberExecutions[memberExecution{groupID, memberID}] != nil
}

func (domain *Execution) MemberUpdates() <-chan struct{} {
	return domain.memberChanges
}

func (domain *Execution) AcquireMember(ctx context.Context, scope event.Scope, member event.ID) (func(), error) {
	if member == "" {
		return func() {}, nil
	}
	groupID, memberID := domain.roster.ExecutionSource(scope, member)
	key := memberExecution{groupID, memberID}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		domain.memberMu.Lock()
		if domain.memberExecutions == nil {
			domain.memberExecutions = make(map[memberExecution]chan struct{})
		}
		previous := domain.memberExecutions[key]
		if previous == nil {
			done := make(chan struct{})
			domain.memberExecutions[key] = done
			domain.memberMu.Unlock()
			domain.memberChanged()
			return func() {
				domain.memberMu.Lock()
				delete(domain.memberExecutions, key)
				close(done)
				domain.memberMu.Unlock()
				domain.memberChanged()
			}, nil
		}
		domain.memberMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-domain.core.Ctx.Done():
			return nil, domain.core.Ctx.Err()
		case <-previous:
		}
	}
}

func (domain *Execution) memberChanged() {
	select {
	case domain.memberChanges <- struct{}{}:
	default:
	}
}
