package definition

type Kind string

const (
	KindBuiltin    Kind = "builtin"
	KindClaudeCode Kind = "claude-code"
	KindCommand    Kind = "command"
	KindCodex      Kind = "codex"
	KindOpenCode   Kind = "opencode"
	KindPi         Kind = "pi"
	KindACP        Kind = "acp"
	KindRemote     Kind = "remote"
)

type Caps struct {
	Steer      bool `json:"steer"`
	Permission bool `json:"permission"`
	MCP        bool `json:"mcp"`
}
