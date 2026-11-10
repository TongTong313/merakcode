package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

func (e *Engine) executionSource(scope event.Scope, member event.ID) (event.ID, event.ID) {
	e.cloudMu.Lock()
	defer e.cloudMu.Unlock()
	for _, run := range e.deviceRuns {
		if run.assignment.Session == scope.Session {
			return run.assignment.SourceGroup, run.assignment.Member
		}
	}
	return scope.Group, member
}

func (e *Engine) executionProject(ctx context.Context, scope event.Scope, fallback string) (string, error) {
	e.cloudMu.Lock()
	for _, run := range e.deviceRuns {
		if run.assignment.Session == scope.Session && run.project != "" {
			project := run.project
			e.cloudMu.Unlock()
			return project, nil
		}
	}
	e.cloudMu.Unlock()
	groupID, _ := e.executionSource(scope, "")
	if groupID == "" {
		return fallback, nil
	}
	state, err := e.Groups.Get(ctx, groupID)
	if err != nil {
		return "", err
	}
	return state.Group.Project.Directory, nil
}
