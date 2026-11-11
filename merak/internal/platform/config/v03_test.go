package config_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

// v03File is a global configuration written the way a v0.3 user wrote it.
const v03File = `{
  // my own settings
  "$schema": "https://merakcode.dev/config.json",
  "locale": "zh-CN",
  "logLevel": "DEBUG",
  "model": "openai/gpt-4.1", // main model
  "small_model": "openai/gpt-4.1-mini",
  "provider": {
    "openai": {
      "options": { "baseURL": "https://relay.example/v1", "apiKey": "sk-test", },
      "models": { "gpt-4.1": { "limit": { "context": 64000, "output": 4096 } } },
    },
  },
  "mcp": {
    "docs": { "type": "local", "command": ["node", "docs.js", "--stdio"], "environment": { "TOKEN": "abc" } },
  },
  "rules": { "user": ["Answer in Chinese"] },
  "experimental": { "anything": true },
}
`

func openV03(t *testing.T) (*config.Store, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "merakcode.jsonc"), []byte(v03File), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return settings, root
}

func TestV03GlobalConfigurationIsReadWithoutChanges(t *testing.T) {
	settings, _ := openV03(t)
	view := settings.Get()
	if view.Model != "openai/gpt-4.1" || view.SmallModel != "openai/gpt-4.1-mini" || view.Locale != "zh-CN" || view.Log != "debug" {
		t.Fatalf("scalar keys: %+v", view)
	}
	if !slices.Equal(view.Rules.User, []string{"Answer in Chinese"}) {
		t.Fatalf("rules: %+v", view.Rules)
	}
	if !slices.ContainsFunc(view.Warnings, func(w string) bool { return strings.Contains(w, "experimental") }) {
		t.Fatalf("the unsupported key is not listed in the warnings: %v", view.Warnings)
	}
}

func TestV03ProviderAndMCPKeysAreMappedAndSecretsStayPrivate(t *testing.T) {
	settings, _ := openV03(t)
	openai := settings.Get().Providers["openai"]
	if openai.BaseURL != "https://relay.example/v1" || !openai.HasKey || openai.APIKey != "" {
		t.Fatalf("public provider: %+v", openai)
	}
	if model := openai.Models["gpt-4.1"]; model.Window != 64000 || model.MaxOutput != 4096 {
		t.Fatalf("model override: %+v", model)
	}
	if settings.Private().Providers["openai"].APIKey != "sk-test" {
		t.Fatal("the private view lost the key")
	}
	docs := settings.Private().MCPServers["docs"]
	if docs.Command != "node" || !slices.Equal(docs.Args, []string{"docs.js", "--stdio"}) || docs.Env["TOKEN"] != "abc" {
		t.Fatalf("mcp server: %+v", docs)
	}
	if settings.Get().MCPServers["docs"].Env["TOKEN"] != "" {
		t.Fatal("the public view discloses MCP environment values")
	}
}

func TestChangingOneSettingOnlyChangesThatSetting(t *testing.T) {
	settings, root := openV03(t)
	next := "openai/gpt-4.1-nano"
	if _, err := settings.Update(config.Patch{Model: &next}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "merakcode.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(v03File, `"model": "openai/gpt-4.1", // main model`, `"model": "openai/gpt-4.1-nano", // main model`, 1)
	if string(got) != want {
		t.Fatalf("the file changed more than the model:\n%s", got)
	}
	if settings.Get().Model != next {
		t.Fatalf("model=%q", settings.Get().Model)
	}
}

func TestANewSettingIsAddedWithoutDisturbingTheFile(t *testing.T) {
	settings, root := openV03(t)
	thinking := "high"
	if _, err := settings.Update(config.Patch{Thinking: &thinking}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "merakcode.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(got), strings.TrimSuffix(strings.TrimSpace(v03File), "}")) {
		t.Fatalf("existing content was rewritten:\n%s", got)
	}
	reopened, err := config.Open(root)
	if err != nil || reopened.Get().Thinking != "high" || reopened.Get().Model != "openai/gpt-4.1" {
		t.Fatalf("reopened=%+v err=%v", reopened.Get(), err)
	}
}

func TestSettingOnlyTheKeyOfAProviderKeepsItsOtherSettings(t *testing.T) {
	settings, root := openV03(t)
	if _, err := settings.Update(config.Patch{Providers: map[string]*config.ProviderPatch{"openai": {APIKey: str("sk-new")}}}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "merakcode.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(v03File, `"apiKey": "sk-test"`, `"apiKey": "sk-new"`, 1)
	if string(got) != want {
		t.Fatalf("the file changed more than the key:\n%s", got)
	}
}

func TestProjectConfigurationIsReadFromBothPlacesAndOverridesTheGlobalOne(t *testing.T) {
	settings, _ := openV03(t)
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".merakcode"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"merakcode.json": `{"model":"anthropic/claude-sonnet","surprise":1,"mcp":{"api":{"type":"local","command":["node","api.js"]}}}`,
		filepath.Join(".merakcode", "merakcode.jsonc"): `{
  // a project-only server
  "mcp": { "files": { "type": "local", "command": ["node", "files.js"], }, },
}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(project, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	effective, err := settings.ForProject(project)
	if err != nil {
		t.Fatal(err)
	}
	if effective.Model != "anthropic/claude-sonnet" || effective.SmallModel != "openai/gpt-4.1-mini" {
		t.Fatalf("model=%q small=%q", effective.Model, effective.SmallModel)
	}
	if _, ok := effective.MCPServers["api"]; !ok || effective.MCPServers["files"].Command != "node" || effective.MCPServers["docs"].Command != "node" {
		t.Fatalf("servers: %+v", effective.MCPServers)
	}
	if !slices.ContainsFunc(effective.Warnings, func(w string) bool { return strings.Contains(w, "surprise") }) {
		t.Fatalf("the unknown project key is not reported: %v", effective.Warnings)
	}
}

func TestEditsCreateAndRemoveKeysInTheFile(t *testing.T) {
	for _, tc := range []struct {
		name, before string
		patch        config.Patch
		check        func(t *testing.T, view config.Value, text string)
	}{
		{"a missing file is created", "", config.Patch{Model: str("a/b")}, func(t *testing.T, view config.Value, text string) {
			if view.Model != "a/b" {
				t.Fatalf("model=%q", view.Model)
			}
		}},
		{"a compact file gets a new provider", `{"model":"a/b"}`, config.Patch{Providers: map[string]*config.ProviderPatch{"deepseek": {APIKey: str("k"), Models: map[string]*config.Model{"deepseek-chat": {Window: 64000}}}}}, func(t *testing.T, view config.Value, text string) {
			if !view.Providers["deepseek"].HasKey || view.Providers["deepseek"].Models["deepseek-chat"].Window != 64000 || view.Model != "a/b" {
				t.Fatalf("view=%+v text=%s", view, text)
			}
		}},
		{"an empty object gets a key", "// notes\n{}\n", config.Patch{Locale: str("en-US")}, func(t *testing.T, view config.Value, text string) {
			if view.Locale != "en-US" || !strings.HasPrefix(text, "// notes\n") {
				t.Fatalf("text=%s", text)
			}
		}},
		{"a value is removed with its line and comma", "{\n  \"model\": \"a/b\",\n  \"locale\": \"zh-CN\"\n}\n", config.Patch{Locale: str("")}, func(t *testing.T, view config.Value, text string) {
			if text != "{\n  \"model\": \"a/b\"\n}\n" {
				t.Fatalf("text=%q", text)
			}
		}},
		{"a model entry and a provider are removed", v03File, config.Patch{Providers: map[string]*config.ProviderPatch{"openai": {Models: map[string]*config.Model{"gpt-4.1": nil}}}}, func(t *testing.T, view config.Value, text string) {
			if _, ok := view.Providers["openai"].Models["gpt-4.1"]; ok || !strings.Contains(text, "// my own settings") {
				t.Fatalf("view=%+v", view.Providers["openai"])
			}
		}},
		{"a provider is switched off", v03File, config.Patch{Providers: map[string]*config.ProviderPatch{"openai": {Disabled: func() *bool { v := true; return &v }()}}}, func(t *testing.T, view config.Value, text string) {
			if !view.Providers["openai"].Disabled || view.Providers["openai"].BaseURL != "https://relay.example/v1" {
				t.Fatalf("view=%+v", view.Providers["openai"])
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			file := filepath.Join(root, "merakcode.jsonc")
			if tc.before != "" {
				if err := os.WriteFile(file, []byte(tc.before), 0600); err != nil {
					t.Fatal(err)
				}
			}
			settings, err := config.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := settings.Update(tc.patch); err != nil {
				t.Fatal(err)
			}
			text, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			reopened, err := config.Open(root)
			if err != nil {
				t.Fatalf("the saved file does not load: %v\n%s", err, text)
			}
			tc.check(t, reopened.Get(), string(text))
		})
	}
}

func TestPermissionEntriesThatV1CanEnforceBecomeRulesAndTheRestIsReported(t *testing.T) {
	root := t.TempDir()
	file := `{"permission":{"bash_risky":{"git push*":"ask","npm publish*":"deny"},"edit":{"docs/**":"allow"},"read":"allow","network":{"*":"ask"}}}`
	if err := os.WriteFile(filepath.Join(root, "merakcode.json"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	view := settings.Get()
	want := []config.PermissionRule{
		{CommandPrefix: "git push", Decision: "ask"}, {CommandPrefix: "npm publish", Decision: "deny"}, {PathPrefix: "docs", Decision: "allow"},
	}
	if !slices.Equal(view.PermissionRules, want) {
		t.Fatalf("rules: %+v", view.PermissionRules)
	}
	for _, key := range []string{"permission.read", "permission.network"} {
		if !slices.ContainsFunc(view.Warnings, func(w string) bool { return strings.HasPrefix(w, key+":") }) {
			t.Errorf("%s is not reported as saved but not enforced: %v", key, view.Warnings)
		}
	}
	if text, _ := os.ReadFile(filepath.Join(root, "merakcode.json")); string(text) != file {
		t.Fatal("reading the file changed it")
	}
}

func TestAProjectPermissionRuleOnlyAppliesToThatProject(t *testing.T) {
	settings, _ := openV03(t)
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "merakcode.json"), []byte(`{"permission":{"bash":{"make test*":"allow"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	effective, err := settings.ForProject(project)
	if err != nil {
		t.Fatal(err)
	}
	want := config.PermissionRule{Project: project, CommandPrefix: "make test", Decision: "allow"}
	if !slices.Contains(effective.PermissionRules, want) {
		t.Fatalf("rules: %+v", effective.PermissionRules)
	}
}

func TestSendingBackWhatWasReadLeavesTheFileUntouched(t *testing.T) {
	settings, root := openV03(t)
	provider := settings.Private().Providers["openai"]
	echo := &config.ProviderPatch{Name: &provider.Name, Protocol: &provider.Protocol, BaseURL: &provider.BaseURL, APIKey: &provider.APIKey, Headers: provider.Headers, Picker: provider.Picker, Disabled: &provider.Disabled, Models: map[string]*config.Model{}}
	for id, model := range provider.Models {
		echo.Models[id] = &model
	}
	if _, err := settings.Update(config.Patch{Providers: map[string]*config.ProviderPatch{"openai": echo}}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, "merakcode.jsonc"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != v03File {
		t.Fatalf("the file changed although nothing did:\n%s", got)
	}
}

func TestSendingBackAModelWithItsThinkingLevelsKeepsTheVariantOptions(t *testing.T) {
	root := t.TempDir()
	file := `{"provider":{"deepseek":{"models":{"deepseek-chat":{"variants":{"high":{"reasoningEffort":"high"},"low":{"disabled":true}}}}}}}`
	if err := os.WriteFile(filepath.Join(root, "merakcode.json"), []byte(file), 0600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	model := settings.Private().Providers["deepseek"].Models["deepseek-chat"]
	if !slices.Equal(model.Thinking, []string{"high"}) {
		t.Fatalf("thinking=%v", model.Thinking)
	}
	if _, err := settings.Update(config.Patch{Providers: map[string]*config.ProviderPatch{"deepseek": {Models: map[string]*config.Model{"deepseek-chat": &model}}}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "merakcode.json")); string(got) != file {
		t.Fatalf("variants were rewritten:\n%s", got)
	}
}
