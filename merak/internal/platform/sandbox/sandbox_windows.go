package sandbox

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

func platformStatus(context.Context, Profile) Status {
	return Status{Backend: "windows-account", Network: "none", Reason: "MRK-5004"}
}

type windowsBrokerRequest struct {
	AccountSID string   `json:"accountSID"`
	StateDir   string   `json:"stateDir"`
	Profile    Profile  `json:"profile"`
	Command    string   `json:"command"`
	Args       []string `json:"args"`
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
	account, err := l.windowsAccount(ctx)
	if err != nil {
		return nil, err
	}
	if err := l.windowsWriteAccess(ctx, p.WriteAllow); err != nil {
		return nil, err
	}
	body, err := json.Marshal(windowsBrokerRequest{AccountSID: account.SID, StateDir: l.StateDir, Profile: p, Command: resolved, Args: args})
	if err != nil {
		return nil, err
	}
	cmd := process.Command(ctx, "", executable, "--merak-sandbox-windows-broker", base64.RawURLEncoding.EncodeToString(body))
	cmd.Env = p.Environment(os.Environ())
	return cmd, nil
}
