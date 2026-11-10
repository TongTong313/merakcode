package permission

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/tool"
)

type Settings interface {
	PermissionRules() []Rule
	PermissionDecision(string) string
	RememberPermissionDecision(key, decision string) error
}

type Grants struct {
	settings func() Settings
	mu       sync.Mutex
	sessions map[string]Decision
}

func NewGrants(settings func() Settings) *Grants {
	return &Grants{settings: settings, sessions: make(map[string]Decision)}
}

func (g *Grants) rules() []Rule {
	if g == nil || g.settings == nil {
		return nil
	}
	return g.settings().PermissionRules()
}

func (g *Grants) decision(call tool.Call, spec tool.Spec, mode Mode) Decision {
	if g == nil {
		return ""
	}
	key := grantKey(call, spec, mode)
	g.mu.Lock()
	decision := g.sessions[string(call.Env.Scope.Session)+":"+key]
	g.mu.Unlock()
	if decision != "" {
		return decision
	}
	if g.settings == nil {
		return ""
	}
	return Decision(g.settings().PermissionDecision(key))
}

func (g *Grants) remember(call tool.Call, spec tool.Spec, mode Mode, reply Reply) error {
	if g == nil || reply.Remember == "" || reply.Leader != "" {
		return nil
	}
	if reply.Decision != Allow && reply.Decision != Deny {
		return errors.New("invalid remembered permission decision")
	}
	key := grantKey(call, spec, mode)
	switch reply.Remember {
	case "session":
		if call.Env.Scope.Session == "" {
			return nil
		}
		g.mu.Lock()
		g.sessions[string(call.Env.Scope.Session)+":"+key] = reply.Decision
		g.mu.Unlock()
		return nil
	case "always":
		if g.settings != nil {
			return g.settings().RememberPermissionDecision(key, string(reply.Decision))
		}
		return nil
	default:
		return errors.New("invalid permission remember scope")
	}
}

// Hash exact operations without persisting command text or tool input in user configuration.
func grantKey(call tool.Call, spec tool.Spec, mode Mode) string {
	var input any
	decoder := json.NewDecoder(bytes.NewReader(call.Input))
	decoder.UseNumber()
	if decoder.Decode(&input) != nil {
		input = string(call.Input)
	}
	workdir, err := resolvePath(call.Env.Workdir)
	if err != nil {
		workdir = call.Env.Workdir
	}
	target := requestFor(call, spec).Path
	if target != "" {
		if !filepath.IsAbs(target) {
			target = filepath.Join(workdir, target)
		}
		if resolved, err := resolvePath(target); err == nil {
			target = resolved
		}
	}
	body, _ := json.Marshal([]any{workdir, target, call.Env.Member, call.Env.Scope.Group, mode, spec.Name, spec.Effect, input})
	key := sha256.Sum256(body)
	return hex.EncodeToString(key[:])
}
