package sandbox

import (
	"sync"
	"time"
)

// Hold keeps a session's account active throughout a turn, including approvals.
func (l *Launcher) Hold() func() {
	if l == nil {
		return func() {}
	}
	l.mu.Lock()
	l.active++
	l.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.active--
			if l.active == 0 {
				l.idleSince = time.Now()
			}
		})
	}
}

// IdleSince reports when a reclaimable session stopped using its account.
func (l *Launcher) IdleSince() time.Time {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.Reclaimable || l.closed || l.lease == nil || l.active != 0 || len(l.running) != 0 {
		return time.Time{}
	}
	return l.idleSince
}

// Reclaim returns an idle account without ending the session or its launcher.
func (l *Launcher) Reclaim() (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.Reclaimable || l.closed || l.lease == nil || l.active != 0 || len(l.running) != 0 {
		return false, nil
	}
	if err := l.lease.Close(); err != nil {
		return false, err
	}
	l.lease = nil
	return true, nil
}
