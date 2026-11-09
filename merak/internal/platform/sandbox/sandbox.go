// Package sandbox starts member processes with operating-system restrictions.
package sandbox

import (
	"context"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type Profile struct {
	ReadDeny          []string `json:"readDeny,omitempty"`
	TransientReadDeny []string `json:"transientReadDeny,omitempty"`
	WriteAllow        []string `json:"writeAllow,omitempty"`
	Protect           []string `json:"protect,omitempty"`
	Network           Network  `json:"network"`
	EnvAllow          []string `json:"envAllow,omitempty"`
}

type Launcher struct {
	Unavailable    func(context.Context, Status) error
	ApproveNetwork func(context.Context, string) (bool, error)
	NetworkDenied  func(context.Context, string) error
	MemberName     string
	Disabled       bool
	StateDir       string
	mu             sync.Mutex
	lease          io.Closer
	closed         bool
	lifetime       context.Context
	endLifetime    context.CancelFunc
}

func (l *Launcher) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	if l.endLifetime != nil {
		l.endLifetime()
	}
	if l.lease != nil {
		err := l.lease.Close()
		if err == nil {
			l.lease = nil
		}
		return err
	}
	return nil
}

type ProtectionStatus struct {
	Path  string `json:"path"`
	State string `json:"state"`
}

type Status struct {
	Disabled  bool               `json:"disabled,omitempty"`
	Available bool               `json:"available"`
	Backend   string             `json:"backend"`
	Network   string             `json:"network"`
	Reason    string             `json:"reason,omitempty"`
	Protect   []ProtectionStatus `json:"protect,omitempty"`
}

func (l *Launcher) Status(ctx context.Context, p Profile) Status {
	if l.Disabled {
		return Status{Disabled: true, Backend: "none", Network: "none"}
	}
	status := platformStatus(ctx, p)
	for _, path := range p.Protect {
		state := "unenforced"
		if _, err := os.Stat(path); os.IsNotExist(err) {
			state = "missing"
		} else if err != nil {
			state = "unknown"
		}
		status.Protect = append(status.Protect, ProtectionStatus{Path: path, State: state})
	}
	return status
}

func (l *Launcher) Command(ctx context.Context, p Profile, name string, args ...string) (*exec.Cmd, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !l.Disabled {
		if err := p.Validate(); err != nil {
			return nil, err
		}
		if l.Unavailable != nil {
			status := l.Status(ctx, p)
			if !status.Available {
				if err := l.Unavailable(ctx, status); err != nil {
					return nil, err
				}
				command := process.Command(ctx, "", name, args...)
				command.Env = p.Environment(os.Environ())
				return command, nil
			}
		}
		return l.platformCommand(ctx, p, name, args...)
	}
	return process.Command(ctx, "", name, args...), nil
}
