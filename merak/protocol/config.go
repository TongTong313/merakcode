package protocol

import (
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/rules"
	"github.com/TongTong313/merakcode/merak/engine/skill"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

type ModelListParams struct {
	Overrides []catalog.Override `json:"overrides,omitempty"`
}

type Config = config.Value
type ConfigPatch = config.Patch
type ConfigProvider = config.Provider
type ConfigProviderPatch = config.ProviderPatch
type ConfigModel = config.Model

type MemoryListParams struct {
	Directory string `json:"directory,omitempty"`
	// Scope is "project" (the default), "group" or "member".
	Scope string `json:"scope,omitempty"`
}

type MemoryNoteParams struct {
	ID event.ID `json:"id"`
}

type MCPStatusParams struct {
	// Directory adds the servers of that project to the answer.
	Directory string `json:"directory,omitempty"`
}

type MCPServerParams struct {
	Server string `json:"server"`
}

type MCPAuthenticateResult struct {
	// URL is the address to open in a browser to log in.
	URL string `json:"url"`
}

type ModelRefreshParams struct {
	Provider string `json:"provider,omitempty"`
}

type ModelDiscoverParams struct {
	Provider ConfigProvider `json:"provider"`
}

// RuleView is a rule file as clients list it.
type RuleView struct {
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	Description string     `json:"description,omitempty"`
	Globs       []string   `json:"globs,omitempty"`
	Kind        rules.Kind `json:"kind"`
	Truncated   bool       `json:"truncated,omitempty"`
	Body        string     `json:"body"`
}

// RulesReadResult is everything that tells the model how to work: the user's personal rules, and what the project says.
type RulesReadResult struct {
	Personal     []string   `json:"personal"`
	Instructions string     `json:"instructions,omitempty"`
	Rules        []RuleView `json:"rules"`
}

// RuleFileChange writes or deletes one rule file of the project; a missing Body deletes it.
type RuleFileChange struct {
	Name string  `json:"name"`
	Body *string `json:"body,omitempty"`
}

// RulesChangeParams changes the personal rules, one project rule file, or both.
type RulesChangeParams struct {
	Directory string          `json:"directory,omitempty"`
	Personal  *[]string       `json:"personal,omitempty"`
	File      *RuleFileChange `json:"file,omitempty"`
}

// SkillListResult is the skills that apply to a folder, and the default places to install more from.
type SkillListResult struct {
	Skills   []skill.Skill `json:"skills"`
	Problems []string      `json:"problems,omitempty"`
	Sources  []string      `json:"sources"`
}

type SkillDiscoverParams struct {
	// Source is an http(s) address with an index.json, or a git repository.
	Source string `json:"source"`
	// Token is used for a private git repository over https; it is never saved.
	Token string `json:"token,omitempty"`
}

type SkillInstallParams struct {
	DirectoryParams
	Source string   `json:"source"`
	Token  string   `json:"token,omitempty"`
	Names  []string `json:"names"`
	// Scope is "project" (the default) or "global".
	Scope string `json:"scope,omitempty"`
}

type SkillInstallResult struct {
	Installed []string `json:"installed"`
}

type SkillUninstallParams struct {
	DirectoryParams
	Name  string `json:"name"`
	Scope string `json:"scope,omitempty"`
}
