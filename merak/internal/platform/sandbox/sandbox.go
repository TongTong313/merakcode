// Package sandbox starts member processes with operating-system restrictions.
package sandbox

import (
	"context"
	"errors"
	"os/exec"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

type Profile struct {
	ReadDeny   []string `json:"readDeny,omitempty"`
	WriteAllow []string `json:"writeAllow,omitempty"`
	Protect    []string `json:"protect,omitempty"`
	Network    Network  `json:"network"`
	EnvAllow   []string `json:"envAllow,omitempty"`
}

type Launcher struct {
	Disabled bool
}

func (l *Launcher) Command(ctx context.Context, _ Profile, name string, args ...string) (*exec.Cmd, error) {
	if !l.Disabled {
		return nil, errors.New("sandbox is unavailable")
	}
	return process.Command(ctx, "", name, args...), nil
}
