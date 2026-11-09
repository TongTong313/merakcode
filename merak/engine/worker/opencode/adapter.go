// Package opencode configures OpenCode's native ACP mode.
package opencode

import (
	"context"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/engine/worker/acp"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"maps"
	"os"
)

type Runner struct {
	Sandbox *sandbox.Launcher
	Store   store.Store
	Bus     *event.Bus
	Gate    *permission.Gate
	Product profile.Product
	System  string
}

func (*Runner) Caps() worker.Caps { return worker.Caps{Permission: true} }
func (r *Runner) Start(ctx context.Context, a worker.Assignment) (worker.Run, error) {
	p := r.Product
	p.Kind = "opencode"
	if p.Binary == "" {
		p.Binary = "opencode"
	}
	p.Args = append([]string(nil), p.Args...)
	if len(p.Args) == 0 || p.Args[0] != "acp" {
		p.Args = append([]string{"acp"}, p.Args...)
	}
	p.Env = maps.Clone(p.Env)
	if p.Env == nil {
		p.Env = map[string]string{}
	}
	config := map[string]any{}
	raw, ok := p.Env["OPENCODE_CONFIG_CONTENT"]
	if !ok {
		raw = os.Getenv("OPENCODE_CONFIG_CONTENT")
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &config); err != nil {
			return nil, err
		}
	}
	if config == nil {
		config = map[string]any{}
	}
	config["permission"] = "ask"
	if a.ReadOnly {
		config["permission"] = map[string]string{"*": "deny", "read": "allow", "glob": "allow", "grep": "allow", "list": "allow"}
	}
	if p.Model != "" {
		config["model"] = p.Model
	}
	body, err := json.Marshal(config)
	if err != nil {
		return nil, err
	}
	p.Env["OPENCODE_CONFIG_CONTENT"] = string(body)
	a.SandboxProfile.EnvAllow = append(append([]string(nil), a.SandboxProfile.EnvAllow...), "OPENCODE_CONFIG_CONTENT")
	for _, name := range []string{"OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_MODELS_FETCH", "OPENCODE_DISABLE_LSP_DOWNLOAD"} {
		p.Env[name] = "1"
		a.SandboxProfile.EnvAllow = append(a.SandboxProfile.EnvAllow, name)
	}
	return (&acp.Runner{Bus: r.Bus, Store: r.Store, Gate: r.Gate, Product: p, System: r.System, Sandbox: r.Sandbox}).Start(ctx, a)
}
