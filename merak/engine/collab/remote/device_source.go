package remote

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (domain *Remote) ExecutionSource(scope event.Scope, member event.ID) (event.ID, event.ID) {
	domain.cloudMu.Lock()
	defer domain.cloudMu.Unlock()
	for _, run := range domain.deviceRuns {
		if run.assignment.Session == scope.Session {
			return run.assignment.SourceGroup, run.assignment.Member
		}
	}
	return scope.Group, member
}

func (domain *Remote) ExecutionProject(ctx context.Context, scope event.Scope, fallback string) (string, error) {
	domain.cloudMu.Lock()
	for _, run := range domain.deviceRuns {
		if run.assignment.Session == scope.Session && run.project != "" {
			project := run.project
			domain.cloudMu.Unlock()
			return project, nil
		}
	}
	domain.cloudMu.Unlock()
	groupID, _ := domain.ExecutionSource(scope, "")
	if groupID == "" {
		return fallback, nil
	}
	state, err := domain.groups.Get(ctx, groupID)
	if err != nil {
		return "", err
	}
	return state.Group.Project.Directory, nil
}
