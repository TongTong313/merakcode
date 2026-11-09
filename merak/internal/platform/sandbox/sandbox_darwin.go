package sandbox

import (
	"context"
	"net/url"
	"os/exec"
	"strconv"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func (l *Launcher) platformStatus(ctx context.Context, p Profile) Status {
	status := Status{Backend: "seatbelt", Network: "none", Reason: "MRK-5004"}
	p, err := existingProtection(p)
	if err != nil {
		return status
	}
	probe := process.Command(ctx, "", "/usr/bin/sandbox-exec", "-p", seatbeltPolicy(p, 0), "/usr/bin/true")
	if probe.Run() != nil {
		return status
	}
	status.Available, status.Network, status.Reason = true, "seatbelt", ""
	return status
}

func (l *Launcher) platformCommand(ctx context.Context, p Profile, name string, args ...string) (*exec.Cmd, error) {
	target, err := exec.LookPath(name)
	if err != nil {
		return nil, err
	}
	address, closeProxy, err := l.hostProxy(ctx, p.Network)
	if err != nil {
		return nil, err
	}
	proxyURL, err := url.Parse(address)
	if err != nil {
		closeProxy()
		return nil, err
	}
	port, err := strconv.Atoi(proxyURL.Port())
	if err != nil {
		closeProxy()
		return nil, err
	}
	p, err = existingProtection(p)
	if err != nil {
		closeProxy()
		return nil, err
	}
	cmd := process.Command(ctx, "", "/usr/bin/sandbox-exec", append([]string{"-p", seatbeltPolicy(p, port), target}, args...)...)
	cmd.Env = proxyEnvironment(p.Environment(cmd.Environ()), address)
	l.mu.Lock()
	if l.startups == nil {
		l.startups = make(map[*exec.Cmd]*commandStartup)
	}
	l.startups[cmd] = &commandStartup{wait: func() error { return nil }, close: closeProxy}
	l.mu.Unlock()
	return cmd, nil
}
