package config_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/internal/platform/config"
)

// openText writes text as the global configuration file of a fresh root and opens it.
func openText(t *testing.T, text string) (*config.Store, string) {
	t.Helper()
	root := t.TempDir()
	file := filepath.Join(root, "merakcode.jsonc")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return settings, file
}

const toolingFile = `{
  // keep this comment
  "lsp": {
    "gopls": { "disabled": true },
    "mine": {
      "command": ["my-lsp", "--stdio"],
      "extensions": [".xyz", ".xy2"],
      "env": { "TOKEN": "secret" },
      "initialization": { "mode": "fast" }
    },
    "broken": "not an object"
  },
  "formatter": {
    "prettier": { "command": ["prettier", "--write", "$FILE"], "extensions": [".ts"], "environment": { "NODE_ENV": "production" } }
  },
  "model": "fake/before"
}
`

func TestLspAndFormatterSectionsAreReadWithSecretsHiddenInThePublicView(t *testing.T) {
	settings, file := openText(t, toolingFile)

	private := settings.Private()
	if gopls := private.LSP.Servers["gopls"]; !gopls.Disabled || len(gopls.Command) != 0 {
		t.Fatalf("gopls = %+v", gopls)
	}
	mine := private.LSP.Servers["mine"]
	var initialization map[string]string
	if err := json.Unmarshal(mine.Initialization, &initialization); err != nil || initialization["mode"] != "fast" {
		t.Fatalf("initialization = %s (%v)", mine.Initialization, err)
	}
	if !slices.Equal(mine.Command, []string{"my-lsp", "--stdio"}) || !slices.Equal(mine.Extensions, []string{".xyz", ".xy2"}) || mine.Env["TOKEN"] != "secret" || mine.Disabled {
		t.Fatalf("mine = %+v", mine)
	}
	prettier := private.Formatter.Entries["prettier"]
	if !slices.Equal(prettier.Command, []string{"prettier", "--write", "$FILE"}) || !slices.Equal(prettier.Extensions, []string{".ts"}) || prettier.Environment["NODE_ENV"] != "production" {
		t.Fatalf("prettier = %+v", prettier)
	}
	if private.LSP.Disabled || private.Formatter.Disabled {
		t.Fatalf("neither section is switched off: %+v %+v", private.LSP, private.Formatter)
	}

	public := settings.Get()
	if got, ok := public.LSP.Servers["mine"].Env["TOKEN"]; !ok || got != "" {
		t.Fatalf("the public environment of a server must keep the name and hide the value: %+v", public.LSP.Servers["mine"].Env)
	}
	if got, ok := public.Formatter.Entries["prettier"].Environment["NODE_ENV"]; !ok || got != "" {
		t.Fatalf("the public environment of a formatter must keep the name and hide the value: %+v", public.Formatter.Entries["prettier"].Environment)
	}
	if settings.Private().LSP.Servers["mine"].Env["TOKEN"] != "secret" {
		t.Fatal("reading the public view changed the private one")
	}

	if len(public.Warnings) != 1 || public.Warnings[0].Path != "lsp.broken" || public.Warnings[0].Code != "MRK-3002" || public.Warnings[0].File != file {
		t.Fatalf("only the entry that is not an object may warn: %v", public.Warnings)
	}
}

func TestLspAndFormatterCanBeSwitchedOffWithAnBooleanAndAnythingElseIsAnError(t *testing.T) {
	settings, _ := openText(t, `{ "lsp": false, "formatter": true }`)
	got := settings.Get()
	if !got.LSP.Disabled || got.Formatter.Disabled || len(got.LSP.Servers) != 0 || len(got.Formatter.Entries) != 0 {
		t.Fatalf("lsp = %+v, formatter = %+v", got.LSP, got.Formatter)
	}
	if len(got.Warnings) != 0 {
		t.Fatalf("booleans must not warn: %v", got.Warnings)
	}
	for _, text := range []string{`{ "lsp": "yes" }`, `{ "formatter": 3 }`, `{ "lsp": ["gopls"] }`} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "merakcode.jsonc"), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := config.Open(root); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Fatalf("%s: err = %v, want an invalid section", text, err)
		}
	}
}

func TestAPatchEditsLspAndFormatterInPlaceAndKeepsSecretsThatTheClientSentBackEmpty(t *testing.T) {
	settings, file := openText(t, toolingFile)
	mine := settings.Get().LSP.Servers["mine"]
	mine.Extensions = []string{".xyz", ".abc"}
	patch := config.Patch{
		LSP: &config.LSPPatch{Servers: map[string]*config.LSPServer{
			"mine":  &mine,
			"gopls": nil,
			"extra": {Command: []string{"extra-lsp"}, Extensions: []string{".ex"}, Env: map[string]string{"KEY": "new"}},
		}},
		Formatter: &config.FormatterPatch{Entries: map[string]*config.FormatterEntry{"prettier": {Disabled: true}}},
	}
	if _, err := settings.Update(patch); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	for _, want := range []string{"keep this comment", `"model": "fake/before"`, `"broken": "not an object"`} {
		if !strings.Contains(string(saved), want) {
			t.Fatalf("the file lacks %q after the edit:\n%s", want, saved)
		}
	}
	check := func(settings *config.Store) {
		t.Helper()
		private := settings.Private()
		changed := private.LSP.Servers["mine"]
		if !slices.Equal(changed.Extensions, []string{".xyz", ".abc"}) || changed.Env["TOKEN"] != "secret" || !slices.Equal(changed.Command, []string{"my-lsp", "--stdio"}) {
			t.Fatalf("mine = %+v: the extensions change and the hidden value stays", changed)
		}
		if _, ok := private.LSP.Servers["gopls"]; ok {
			t.Fatal("a null entry must delete the server")
		}
		if extra := private.LSP.Servers["extra"]; extra.Env["KEY"] != "new" || !slices.Equal(extra.Command, []string{"extra-lsp"}) {
			t.Fatalf("extra = %+v", extra)
		}
		if prettier := private.Formatter.Entries["prettier"]; !prettier.Disabled || len(prettier.Command) != 0 || len(prettier.Environment) != 0 {
			t.Fatalf("an entry is replaced as a whole: %+v", prettier)
		}
	}
	check(settings)
	reopened, err := config.Open(filepath.Dir(file))
	if err != nil {
		t.Fatal(err)
	}
	check(reopened)
	if got := reopened.Get().Warnings; len(got) != 1 || got[0].Path != "lsp.broken" {
		t.Fatalf("the entry that is not an object stays in the file and keeps warning: %v", got)
	}
}

func TestASectionSwitchedOffBecomesFalseAndComesBackAsAnObjectWithItsNewEntries(t *testing.T) {
	settings, file := openText(t, toolingFile)
	on, off := false, true
	if _, err := settings.Update(config.Patch{LSP: &config.LSPPatch{Disabled: &off}}); err != nil {
		t.Fatal(err)
	}
	saved, _ := os.ReadFile(file)
	if !strings.Contains(string(saved), `"lsp": false`) {
		t.Fatalf("a section that is switched off is written as false:\n%s", saved)
	}
	if got := settings.Get().LSP; !got.Disabled || len(got.Servers) != 0 {
		t.Fatalf("lsp = %+v: the entries go with the switch", got)
	}
	fresh := &config.LSPServer{Command: []string{"again"}, Extensions: []string{".ag"}}
	if _, err := settings.Update(config.Patch{LSP: &config.LSPPatch{Disabled: &on, Servers: map[string]*config.LSPServer{"again": fresh}}}); err != nil {
		t.Fatal(err)
	}
	reopened, err := config.Open(filepath.Dir(file))
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Get().LSP; got.Disabled || len(got.Servers) != 1 || !slices.Equal(got.Servers["again"].Command, []string{"again"}) {
		t.Fatalf("lsp = %+v", got)
	}

	// An entry alone also brings back a section that is false.
	if _, err := settings.Update(config.Patch{Formatter: &config.FormatterPatch{Disabled: &off}}); err != nil {
		t.Fatal(err)
	}
	if _, err := settings.Update(config.Patch{Formatter: &config.FormatterPatch{Entries: map[string]*config.FormatterEntry{"gofmt": {Command: []string{"gofmt", "-w"}, Extensions: []string{".go"}}}}}); err != nil {
		t.Fatal(err)
	}
	if got := settings.Get().Formatter; got.Disabled || got.Entries["gofmt"].Command[0] != "gofmt" {
		t.Fatalf("formatter = %+v", got)
	}
}

func TestABadPatchIsRejectedWholeAndLeavesTheFileUntouched(t *testing.T) {
	settings, file := openText(t, toolingFile)
	before, _ := os.ReadFile(file)
	good := &config.LSPServer{Command: []string{"fine"}, Extensions: []string{".ok"}}
	for name, patch := range map[string]config.Patch{
		"an empty command part":                         {LSP: &config.LSPPatch{Servers: map[string]*config.LSPServer{"good": good, "bad": {Command: []string{"x", ""}}}}},
		"an extension without dot":                      {LSP: &config.LSPPatch{Servers: map[string]*config.LSPServer{"bad": {Command: []string{"x"}, Extensions: []string{"xyz"}}}}},
		"a lone dot":                                    {Formatter: &config.FormatterPatch{Entries: map[string]*config.FormatterEntry{"bad": {Command: []string{"x"}, Extensions: []string{"."}}}}},
		"an empty server name":                          {LSP: &config.LSPPatch{Servers: map[string]*config.LSPServer{"": good}}},
		"an empty formatter name":                       {Formatter: &config.FormatterPatch{Entries: map[string]*config.FormatterEntry{" ": {Command: []string{"x"}}}}},
		"a bad entry in a section that is switched off": {LSP: &config.LSPPatch{Disabled: ptr(true), Servers: map[string]*config.LSPServer{"bad": {Command: []string{""}}}}},
	} {
		if _, err := settings.Update(patch); err == nil {
			t.Fatalf("%s: the patch was accepted", name)
		}
		after, _ := os.ReadFile(file)
		if string(after) != string(before) {
			t.Fatalf("%s: the file changed:\n%s", name, after)
		}
	}
}

func ptr[T any](value T) *T { return &value }

func TestAProjectReplacesEntriesWholeAndSwitchesASectionOffOnlyForItself(t *testing.T) {
	settings, _ := openText(t, toolingFile)
	project := t.TempDir()
	text := `{ "lsp": { "mine": { "command": ["project-lsp"], "extensions": [".pp"] } }, "formatter": false }`
	if err := os.WriteFile(filepath.Join(project, "merakcode.jsonc"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	merged, err := settings.ForProject(project)
	if err != nil {
		t.Fatal(err)
	}
	mine := merged.LSP.Servers["mine"]
	if !slices.Equal(mine.Command, []string{"project-lsp"}) || !slices.Equal(mine.Extensions, []string{".pp"}) || len(mine.Env) != 0 || mine.Initialization != nil {
		t.Fatalf("the project entry must replace the global one whole, nothing of the old entry stays: %+v", mine)
	}
	if !merged.LSP.Servers["gopls"].Disabled {
		t.Fatalf("an entry the project does not name stays: %+v", merged.LSP.Servers)
	}
	if !merged.Formatter.Disabled {
		t.Fatal("the project switched the formatter off")
	}
	global := settings.Private()
	if global.Formatter.Disabled || global.Formatter.Entries["prettier"].Command == nil || global.LSP.Servers["mine"].Env["TOKEN"] != "secret" {
		t.Fatalf("reading a project must not change the global configuration: %+v %+v", global.LSP, global.Formatter)
	}
}
