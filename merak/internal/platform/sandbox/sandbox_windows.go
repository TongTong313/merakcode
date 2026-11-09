package sandbox

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func (l *Launcher) platformStatus(ctx context.Context, _ Profile) Status {
	status := Status{Backend: "windows-account", Network: "none", Reason: "MRK-5004"}
	if ctx.Err() != nil {
		return status
	}
	manifest, err := readWindowsAccounts(l.StateDir)
	if err != nil {
		return status
	}
	if err := cleanWindowsClaims(l.StateDir, manifest.Accounts); err != nil {
		return status
	}
	for _, account := range manifest.Accounts {
		if ctx.Err() != nil {
			return status
		}
		password, err := accountPassword(account)
		if err != nil {
			return status
		}
		if _, err := windowsUnreadableAncestors(account.Name, password, nil); err != nil {
			return status
		}
	}
	l.mu.Lock()
	failed := l.runtimeFailure
	l.mu.Unlock()
	if failed {
		return status
	}
	status.Available, status.Reason, status.Network = true, "", "account"
	status.Limits = []string{"loopback-open", "own-addresses-open"}
	return status
}

type windowsBrokerRequest struct {
	StartupAddress string   `json:"startupAddress"`
	StartupToken   string   `json:"startupToken"`
	AccountSID     string   `json:"accountSID"`
	StateDir       string   `json:"stateDir"`
	Profile        Profile  `json:"profile"`
	Command        string   `json:"command"`
	Args           []string `json:"args"`
}

func (l *Launcher) platformCommand(ctx context.Context, p Profile, name string, args ...string) (*exec.Cmd, error) {
	if _, err := readWindowsAccounts(l.StateDir); err != nil {
		return nil, errors.New("MRK-5004")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	resolved, err := exec.LookPath(name)
	if err != nil {
		return nil, err
	}
	project := l.Project
	if project == "" && len(p.WriteAllow) > 0 {
		project = p.WriteAllow[0]
	}
	account, err := l.windowsAccount(ctx, project)
	if err != nil {
		return nil, err
	}
	if err := l.windowsAncestorAccess(append(append([]string(nil), p.WriteAllow...), executable, filepath.Join(l.StateDir, "member"))); err != nil {
		return nil, err
	}
	if err := l.windowsWriteAccess(ctx, p.WriteAllow); err != nil {
		return nil, err
	}
	if err := l.windowsReadDenials(ctx, p.TransientReadDeny); err != nil {
		return nil, err
	}
	if err := l.windowsDenyAccess(ctx, p.Protect, "(WD,AD,WEA,WA,DE,DC)"); err != nil {
		return nil, err
	}
	startup, address, token, err := l.windowsStartup(ctx)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(windowsBrokerRequest{StartupAddress: address, StartupToken: token, AccountSID: account.SID, StateDir: l.StateDir, Profile: p, Command: resolved, Args: args})
	if err != nil {
		startup.close()
		return nil, err
	}
	cmd := process.Command(ctx, "", executable, "--merak-sandbox-windows-broker", base64.RawURLEncoding.EncodeToString(body))
	proxy, closeProxy, err := l.hostProxy(ctx, p.Network)
	if err != nil {
		startup.close()
		return nil, err
	}
	closeStartup := startup.close
	startup.close = func() { closeStartup(); closeProxy() }
	cmd.Env = proxyEnvironment(p.Environment(cmd.Environ()), proxy)
	l.mu.Lock()
	if l.startups == nil {
		l.startups = make(map[*exec.Cmd]*commandStartup)
	}
	l.startups[cmd] = startup
	l.mu.Unlock()
	return cmd, nil
}
