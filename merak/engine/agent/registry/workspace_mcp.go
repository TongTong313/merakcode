package registry

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/agent/mcp"
	"github.com/TongTong313/merakcode/merak/engine/agent/skill"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/git"
)

func (e *Registry) MCPLogin() *mcp.Login {
	e.mcpLoginOnce.Do(func() { e.mcpLoginSet = &mcp.Login{Vault: e.vault} })
	return e.mcpLoginSet
}

// MCPDefinitions returns the MCP servers that apply to a folder: the user's, and those of the project, which stay
// disabled until the user confirmed them.
func (e *Registry) MCPDefinitions(ctx context.Context, directory string) map[string]config.MCPServer {
	settings := e.NetworkConfiguration()
	servers := make(map[string]config.MCPServer)
	user := make(map[string]bool)
	for name, definition := range settings.MCPServers() {
		servers[name], user[name] = definition, true
	}
	if found, err := config.ReadWorkspace(directory); err == nil {
		project := directory
		if root, err := git.ProjectRoot(ctx, directory); err == nil {
			project = root
		}
		if resolved, err := ResolvedSandboxPath(project); err == nil {
			project = resolved
		}
		for name, definition := range found.MCPServers {
			if user[name] {
				continue
			}
			if settings.WorkspaceDecision(project, "mcpServers/"+name, definition.Hash()) != "allow" {
				definition.Disabled = true
			}
			servers[name] = definition
		}
	}
	return servers
}

// SkillRoots are the folders besides a project's own where skills live.
type SkillRoots struct {
	// Global is the root that holds a skills folder, ~/.merakcode.
	Global string
	// Extra are folders that hold skill folders directly (skills.paths of the configuration).
	Extra []string
	// URLs are the default sources to install from (skills.urls).
	URLs []string
}

// ConfigureSkills tells the engine where the user's skills are: the root with a skills folder, extra folders and
// the default install sources. It takes effect for conversations started afterwards.
func (e *Registry) ConfigureSkills(global string, extra, urls []string) {
	e.skillRoots.Store(&SkillRoots{Global: global, Extra: append([]string(nil), extra...), URLs: append([]string(nil), urls...)})
}

func (e *Registry) Skills(workdir string) (skill.Set, error) {
	roots := e.skillRoots.Load()
	if roots == nil {
		roots = &SkillRoots{}
	}
	return skill.Discover(workdir, roots.Global, roots.Extra...)
}

func (e *Registry) StartMCP(ctx context.Context, name string, definition config.MCPServer, env tool.Env) (*mcp.Process, error) {
	if definition.Remote() {
		return mcp.StartRemote(ctx, name, definition, e.MCPLogin())
	}
	return mcp.Start(ctx, name, definition, env)
}
