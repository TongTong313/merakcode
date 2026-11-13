package migrate

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

type v03Product struct {
	Command string   `json:"command"`
	Enabled *bool    `json:"enabled"`
	Title   string   `json:"title"`
	Adapter string   `json:"adapter"`
	Args    []string `json:"args"`
	Model   *struct {
		ID string `json:"id"`
	} `json:"model"`
}

type v03Role struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Duty string `json:"duty"`
}

// products maps the adapter names of v0.3 to the products of v1 and the program each one starts by default. The
// adapter "member" is a script the user wrote with the adapter generator and has no counterpart.
var products = map[string]struct {
	kind   worker.Kind
	binary string
}{
	"claude":   {worker.KindClaudeCode, "claude"},
	"codex":    {worker.KindCodex, "codex"},
	"opencode": {worker.KindOpenCode, "opencode"},
	"command":  {worker.KindCommand, ""},
}

// importAgents turns the external product connections of the configuration into agents and its role templates into
// worker agents. The configuration file itself stays as it is.
func (r *run) importAgents() {
	keys, err := config.ReadGlobalKeys(r.m.options.Root, "agentConnections", "collaboration")
	if err != nil {
		r.skip("config", "merakcode", codeRecord, errors.New("the configuration file cannot be read"))
		return
	}
	var connections struct {
		Products map[string]v03Product `json:"products"`
	}
	if raw, ok := keys["agentConnections"]; ok && json.Unmarshal(raw, &connections) != nil {
		r.skip("config", "agentConnections", codeRecord, errors.New("agentConnections is not valid"))
	}
	for _, key := range slices.Sorted(maps.Keys(connections.Products)) {
		r.importProduct(key, connections.Products[key])
	}
	var collaboration struct {
		Roles map[string]v03Role `json:"roleTemplates"`
	}
	if raw, ok := keys["collaboration"]; ok && json.Unmarshal(raw, &collaboration) != nil {
		r.skip("config", "collaboration", codeRecord, errors.New("collaboration is not valid"))
	}
	for _, key := range slices.Sorted(maps.Keys(collaboration.Roles)) {
		r.importRole(key, collaboration.Roles[key])
	}
}

func (r *run) importProduct(key string, connection v03Product) {
	if _, done := r.record.Agents["product:"+key]; done {
		return
	}
	known, supported := products[connection.Adapter]
	switch {
	case connection.Adapter == "member" || !supported && connection.Adapter != "":
		r.result.Adapters = append(r.result.Adapters, key)
		r.skip("agent", key, codeAdapter, errors.New("the adapter "+connection.Adapter+" is a script of the user"))
		return
	case connection.Enabled != nil && !*connection.Enabled:
		r.skip("agent", key, codeRecord, errors.New("the connection was switched off"))
		return
	case !supported:
		r.skip("agent", key, codeRecord, errors.New("the connection names no adapter"))
		return
	}
	binary := connection.Command
	if binary == "" {
		binary = known.binary
	}
	if binary == "" {
		r.skip("agent", key, codeRecord, errors.New("the connection names no command"))
		return
	}
	name := connection.Title
	if name == "" {
		name = key
	}
	product := &agent.Product{Kind: known.kind, Binary: binary, Args: connection.Args}
	if connection.Model != nil {
		product.Model = connection.Model.ID
	}
	saved, err := r.m.options.Engine.SaveAgent(r.ctx, r.m.options.Human, agent.Agent{ID: event.ID("v03-product-" + agentID(key)), Name: name, ToolPool: "worker.default", Product: product})
	if err != nil {
		r.skip("agent", key, codeRecord, err)
		return
	}
	r.record.Agents["product:"+key] = string(saved.ID)
	r.result.Imported.Agents++
	r.saved()
}

func (r *run) importRole(key string, template v03Role) {
	if _, done := r.record.Agents["role:"+key]; done {
		return
	}
	if strings.TrimSpace(template.Name) == "" {
		r.skip("role", key, codeRecord, errors.New("the role template has no name"))
		return
	}
	saved, err := r.m.options.Engine.SaveAgent(r.ctx, r.m.options.Human, agent.Agent{ID: event.ID("v03-role-" + agentID(key)), Name: template.Name, Summary: template.Role, Duties: template.Duty, ToolPool: "worker.default"})
	if err != nil {
		r.skip("role", key, codeRecord, err)
		return
	}
	r.record.Agents["role:"+key] = string(saved.ID)
	r.result.Imported.Roles++
	r.saved()
}

// agentID keeps the key of a product or role in the id of its agent.
func agentID(key string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ' ' {
			return '-'
		}
		return r
	}, key)
}

// saved writes the record and only logs a failure: what was imported stays imported.
func (r *run) saved() {
	if err := r.save(); err != nil {
		r.m.log().Warn("the import record could not be saved", "code", codeFailed)
	}
}
