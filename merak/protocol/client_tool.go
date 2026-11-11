package protocol

import "encoding/json"

// ToolRegisterParams offers one tool of the client to the models. The tool is listed to them as client__<name> and
// lasts until the client unregisters it or its connection closes.
type ToolRegisterParams struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	// Effect is what the tool does when it runs: "read", "write", "exec" or "network"; empty means "exec", which
	// is always asked about unless a rule allows it.
	Effect string `json:"effect,omitempty"`
}

type ToolUnregisterParams struct {
	Name string `json:"name"`
}

// ToolCallParams is the tool.call notification: the engine asks the client that registered a tool to run it. The
// client answers with a tool.result call that carries the same Call.
type ToolCallParams struct {
	Call  string          `json:"call"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

type ToolResultParams struct {
	Call    string `json:"call"`
	Text    string `json:"text"`
	IsError bool   `json:"isError,omitempty"`
}
