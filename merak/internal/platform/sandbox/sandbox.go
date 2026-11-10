// Package sandbox starts member processes with operating-system restrictions.
package sandbox

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type Profile struct {
	PrivateDirectory  string   `json:"privateDirectory,omitempty"`
	ReadDeny          []string `json:"readDeny,omitempty"`
	TransientReadDeny []string `json:"transientReadDeny,omitempty"`
	WriteAllow        []string `json:"writeAllow,omitempty"`
	Protect           []string `json:"protect,omitempty"`
	Network           Network  `json:"network"`
	EnvAllow          []string `json:"envAllow,omitempty"`
}

type Launcher struct {
	Unavailable        func(context.Context, Status) error
	ApproveNetwork     func(context.Context, string) (bool, error)
	NetworkDenied      func(context.Context, NetworkDenial) error
	ProtectionChanged  func(*ProtectionError) error
	FileDenied         func(*DenialError) error
	MemberName         string
	Disabled           bool
	StateDir           string
	Project            string
	Reclaimable        bool
	ReclaimAccount     func() (bool, error)
	mu                 sync.Mutex
	privateDirectories map[string]struct{}
	lease              io.Closer
	closed             bool
	lifetime           context.Context
	endLifetime        context.CancelFunc
	protections        map[*exec.Cmd][]protectionSnapshot
	running            map[*exec.Cmd]*launchRun
	closeDone          chan struct{}
	closeErr           error
	startups           map[*exec.Cmd]*commandStartup
	runtimeFailure     bool
	waitingAccount     bool
	active             int
	idleSince          time.Time
	previousAccount    string
}

type commandStartup struct {
	wait  func() error
	close func()
}

type launchRun struct {
	once   sync.Once
	done   chan struct{}
	err    error
	denial *denialCapture
}

func (l *Launcher) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	if l.closeDone != nil {
		done := l.closeDone
		l.mu.Unlock()
		<-done
		return l.closeErr
	}
	l.closeDone = make(chan struct{})
	l.closed = true
	if l.endLifetime != nil {
		l.endLifetime()
	}
	var commands []*exec.Cmd
	for cmd := range l.running {
		commands = append(commands, cmd)
	}
	lease := l.lease
	var startups []*commandStartup
	for _, startup := range l.startups {
		startups = append(startups, startup)
	}
	l.mu.Unlock()
	for _, startup := range startups {
		startup.close()
	}
	for _, cmd := range commands {
		if cmd.Cancel != nil {
			_ = cmd.Cancel()
		} else {
			_ = cmd.Process.Kill()
		}
	}
	for _, cmd := range commands {
		_ = l.Wait(cmd)
	}
	if lease != nil {
		l.closeErr = errors.Join(l.closeErr, lease.Close())
	}
	l.mu.Lock()
	l.lease = nil
	close(l.closeDone)
	l.mu.Unlock()
	return l.closeErr
}

type ProtectionStatus struct {
	Path  string `json:"path"`
	State string `json:"state"`
}

type Status struct {
	WaitingAccount bool               `json:"waitingAccount,omitempty"`
	Disabled       bool               `json:"disabled,omitempty"`
	Available      bool               `json:"available"`
	Backend        string             `json:"backend"`
	Network        string             `json:"network"`
	Limits         []string           `json:"limits,omitempty"`
	Reason         string             `json:"reason,omitempty"`
	Protect        []ProtectionStatus `json:"protect,omitempty"`
}

func (l *Launcher) Status(ctx context.Context, p Profile) Status {
	if l.Disabled {
		return Status{Disabled: true, Backend: "none", Network: "none"}
	}
	status := l.platformStatus(ctx, p)
	l.mu.Lock()
	status.WaitingAccount = l.waitingAccount
	l.mu.Unlock()
	for _, path := range p.Protect {
		state := "unenforced"
		if status.Available && (status.Backend == "windows-account" || status.Backend == "seatbelt") {
			state = "enforced"
		}
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
			if !status.Available || status.Network == "none" {
				if err := l.Unavailable(ctx, status); err != nil {
					return nil, err
				}
			}
			if !status.Available {
				command := process.Command(ctx, "", name, args...)
				command.Env = p.Environment(command.Environ())
				return command, nil
			}
		}
		if runtime.GOOS == "windows" {
			return l.platformCommand(ctx, p, name, args...)
		}
		prepared, cleanup, err := l.privateProfile(p)
		if err != nil {
			return nil, err
		}
		cmd, err := l.platformCommand(ctx, prepared, name, args...)
		if err != nil {
			cleanup()
			return nil, err
		}
		l.mu.Lock()
		if l.startups == nil {
			l.startups = make(map[*exec.Cmd]*commandStartup)
		}
		startup := l.startups[cmd]
		if startup == nil {
			startup = &commandStartup{wait: func() error { return nil }, close: cleanup}
			l.startups[cmd] = startup
		} else {
			closePrevious := startup.close
			startup.close = func() { closePrevious(); cleanup() }
		}
		l.mu.Unlock()
		return cmd, nil
	}
	return process.Command(ctx, "", name, args...), nil
}
