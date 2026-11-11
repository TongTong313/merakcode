package config

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
	Warnings         []string             `json:"warnings,omitempty"`
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

type Patch struct {
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
