package config

import "strings"

type Model struct {
	Name      string   `json:"name,omitempty"`
	Window    int      `json:"window,omitempty"`
	MaxOutput int      `json:"maxOutput,omitempty"`
	Thinking  []string `json:"thinking,omitempty"`
}

// Provider is the public and the private view of one provider. The private view carries the key and the headers.
type Provider struct {
	Picker     *Picker           `json:"picker,omitempty"`
	Station    string            `json:"station,omitempty"`
	Group      string            `json:"group,omitempty"`
	Auth       string            `json:"auth,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	HasHeaders bool              `json:"hasHeaders,omitempty"`
	Name       string            `json:"name,omitempty"`
	Protocol   string            `json:"protocol,omitempty"`
	BaseURL    string            `json:"baseURL,omitempty"`
	APIKey     string            `json:"apiKey,omitempty"`
	HasKey     bool              `json:"hasKey,omitempty"`
	Disabled   bool              `json:"disabled,omitempty"`
	Models     map[string]Model  `json:"models,omitempty"`
}

type Picker struct {
	Include []string `json:"include,omitempty"`
	Exclude []string `json:"exclude,omitempty"`
}

type Server struct {
	Port     int    `json:"port,omitempty"`
	Hostname string `json:"hostname,omitempty"`
}

type Rules struct {
	User []string `json:"user,omitempty"`
}

type Cloud struct {
	Endpoint string `json:"endpoint,omitempty"`
}

// Warning is one entry of a configuration file that was skipped or is not used. The configuration still loads.
type Warning struct {
	// Code is the MRK code a client shows; Path is the key that was skipped, such as "mcp.local" or "memory.x".
	Code string `json:"code"`
	Path string `json:"path"`
	// File is the file the entry is in.
	File    string `json:"file,omitempty"`
	Message string `json:"message"`
}

func (w Warning) String() string { return w.Path + ": " + w.Message }

// warn records warnings written as "path: message".
func (v *Value) warn(texts ...string) {
	for _, text := range texts {
		path, message, found := strings.Cut(text, ": ")
		if !found {
			path, message = "", text
		}
		v.Warnings = append(v.Warnings, Warning{Code: "MRK-3002", Path: path, Message: message})
	}
}

// inFile says which file the warnings that have no file yet came from.
func (v *Value) inFile(file string) {
	for i := range v.Warnings {
		if v.Warnings[i].File == "" {
			v.Warnings[i].File = file
		}
	}
}

// Value is the configuration the program uses. It is read from the v0.3 file format; Warnings lists what was ignored.
type Value struct {
	Cloud            Cloud                `json:"cloud,omitempty"`
	PermissionMode   string               `json:"permissionMode,omitempty"`
	MCPServers       map[string]MCPServer `json:"mcpServers,omitempty"`
	WorkspaceTrust   []Trust              `json:"workspaceTrust,omitempty"`
	PermissionRules  []PermissionRule     `json:"permissionRules,omitempty"`
	PermissionGrants []PermissionGrant    `json:"permissionGrants,omitempty"`
	Unconfined       []LaunchDecision     `json:"unconfined,omitempty"`
	AllowedHosts     []string             `json:"allowedHosts,omitempty"`
	DeniedHosts      []string             `json:"deniedHosts,omitempty"`
	Model            string               `json:"model,omitempty"`
	SmallModel       string               `json:"smallModel,omitempty"`
	Thinking         string               `json:"thinking,omitempty"`
	Locale           string               `json:"locale,omitempty"`
	Log              string               `json:"log,omitempty"`
	Server           Server               `json:"server,omitempty"`
	Rules            Rules                `json:"rules,omitempty"`
	EnabledProviders []string             `json:"enabledProviders,omitempty"`
	Providers        map[string]Provider  `json:"providers"`
	Board            Board                `json:"board"`
	// Memory decides what the engine remembers across conversations; both switches default to off.
	Memory Memory `json:"memory"`
	// Tools switches tools off or on by name (the v0.3 tools section); a name may end in * and "exa" means both searches.
	Tools map[string]bool `json:"tools,omitempty"`
	// Agents are the entries of the agent section and DefaultAgent is the agent a new conversation starts with (v0.3 agent and default_agent).
	Agents       map[string]Agent `json:"agents,omitempty"`
	DefaultAgent string           `json:"defaultAgent,omitempty"`
	// Commands are the slash commands of the configuration (the v0.3 command section).
	Commands map[string]Command `json:"commands,omitempty"`
	// Skills are the extra folders to find skills in and the default sources to install them from (v0.3 skills.paths and skills.urls).
	Skills Skills `json:"skills"`
	// Snapshot keeps the files of a conversation so a revert can put them back (default on).
	Snapshot bool `json:"snapshot"`
	// CompactionAuto lets a conversation shrink its own context when it fills up (default on).
	CompactionAuto bool `json:"compactionAuto"`
	// RetentionDays deletes conversations idle for this many days; 0 keeps them for ever.
	RetentionDays int       `json:"retentionDays,omitempty"`
	Warnings      []Warning `json:"warnings,omitempty"`
}

// ProviderPatch changes only the fields it names. A string field set to "" removes the key from the file.
type ProviderPatch struct {
	Name         *string           `json:"name,omitempty"`
	Protocol     *string           `json:"protocol,omitempty"`
	BaseURL      *string           `json:"baseURL,omitempty"`
	APIKey       *string           `json:"apiKey,omitempty"`
	Auth         *string           `json:"auth,omitempty"`
	Station      *string           `json:"station,omitempty"`
	Group        *string           `json:"group,omitempty"`
	Headers      map[string]string `json:"headers,omitempty"`
	ClearHeaders bool              `json:"clearHeaders,omitempty"`
	Picker       *Picker           `json:"picker,omitempty"`
	Disabled     *bool             `json:"disabled,omitempty"`
	Models       map[string]*Model `json:"models,omitempty"`
	// HasKey and HasHeaders are derived fields of the public view. A client that sends a view back may include
	// them; they are ignored.
	HasKey     bool `json:"hasKey,omitempty"`
	HasHeaders bool `json:"hasHeaders,omitempty"`
}

// Command is one entry of the v0.3 command section.
type Command struct {
	Template    string `json:"template"`
	Description string `json:"description,omitempty"`
	Agent       string `json:"agent,omitempty"`
	Model       string `json:"model,omitempty"`
}

// Skills is the v0.3 `skills` section.
type Skills struct {
	Paths []string `json:"paths,omitempty"`
	URLs  []string `json:"urls,omitempty"`
}

// Memory is the v0.3 `memory` section, of which v1 uses three keys.
type Memory struct {
	// AutoExtract saves notes from a conversation once it is idle (v0.3 auto_extract: true, "signals" or "always").
	AutoExtract bool `json:"autoExtract"`
	// AutoRecall puts the notes that fit a message into its first turn (v0.3 auto_recall).
	AutoRecall bool `json:"autoRecall"`
	// Model names the model that writes notes (v0.3 model); empty means the small or the default model.
	Model string `json:"model,omitempty"`
}

// RulesPatch changes the rules in the global file.
type RulesPatch struct {
	User *[]string `json:"user,omitempty"`
}

// MemoryPatch changes the memory settings.
type MemoryPatch struct {
	AutoExtract *bool   `json:"autoExtract,omitempty"`
	AutoRecall  *bool   `json:"autoRecall,omitempty"`
	Model       *string `json:"model,omitempty"`
}

// Board holds the settings of the task board.
type Board struct {
	// AutoArchiveDays is how many days a finished task stays on the board before it is archived; 0 turns it off.
	AutoArchiveDays int `json:"autoArchiveDays"`
}

// DefaultAutoArchiveDays applies while the file does not say.
const DefaultAutoArchiveDays = 3

// BoardPatch changes the settings of the board.
type BoardPatch struct {
	AutoArchiveDays *int `json:"autoArchiveDays,omitempty"`
}

type Patch struct {
	Board *BoardPatch `json:"board,omitempty"`
	// MCP adds or replaces servers by name; a null entry deletes the server.
	MCP    map[string]*MCPServer `json:"mcp,omitempty"`
	Memory *MemoryPatch          `json:"memory,omitempty"`
	// Rules replaces the personal rules; nil leaves them.
	Rules            *RulesPatch               `json:"rules,omitempty"`
	DefaultAgent     *string                   `json:"defaultAgent,omitempty"`
	Snapshot         *bool                     `json:"snapshot,omitempty"`
	CompactionAuto   *bool                     `json:"compactionAuto,omitempty"`
	RetentionDays    *int                      `json:"retentionDays,omitempty"`
	Cloud            *Cloud                    `json:"cloud,omitempty"`
	PermissionMode   *string                   `json:"permissionMode,omitempty"`
	PermissionRules  *[]PermissionRule         `json:"permissionRules,omitempty"`
	PermissionGrants *[]PermissionGrant        `json:"permissionGrants,omitempty"`
	Unconfined       *[]LaunchDecision         `json:"unconfined,omitempty"`
	AllowedHosts     *[]string                 `json:"allowedHosts,omitempty"`
	DeniedHosts      *[]string                 `json:"deniedHosts,omitempty"`
	Model            *string                   `json:"model,omitempty"`
	SmallModel       *string                   `json:"smallModel,omitempty"`
	Thinking         *string                   `json:"thinking,omitempty"`
	Locale           *string                   `json:"locale,omitempty"`
	Log              *string                   `json:"log,omitempty"`
	Providers        map[string]*ProviderPatch `json:"providers,omitempty"`
}
