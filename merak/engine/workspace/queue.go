package workspace

import (
	"context"
	"sync"
)

// Queue runs each project's integrations in arrival order.
type Queue struct {
	mu       sync.Mutex
	projects map[string][]chan struct{}
}

func (q *Queue) Do(ctx context.Context, project string, operation func(context.Context) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	ready := make(chan struct{})
	q.mu.Lock()
	if q.projects == nil {
		q.projects = make(map[string][]chan struct{})
	}
	q.projects[project] = append(q.projects[project], ready)
	if len(q.projects[project]) == 1 {
		close(ready)
	}
	q.mu.Unlock()
	defer q.remove(project, ready)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-ready:
		if err := ctx.Err(); err != nil {
			return err
		}
		return operation(ctx)
	}
}

func (q *Queue) remove(project string, ready chan struct{}) {
	q.mu.Lock()
	defer q.mu.Unlock()
	requests := q.projects[project]
	for i, request := range requests {
		if request != ready {
			continue
		}
		requests = append(requests[:i], requests[i+1:]...)
		if len(requests) == 0 {
			delete(q.projects, project)
			return
		}
		q.projects[project] = requests
		if i == 0 {
			close(requests[0])
		}
		return
	}
}
