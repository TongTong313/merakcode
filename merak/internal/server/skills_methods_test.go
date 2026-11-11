package server_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/skill"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func TestSkillMethodsListDiscoverInstallAndUninstallForTheProjectAndTheUser(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			fmt.Fprint(w, `{"skills":[{"name":"lint","description":"Run linters","files":["SKILL.md"]}]}`)
		case "/lint/SKILL.md":
			fmt.Fprint(w, "---\nname: lint\ndescription: Run linters\n---\nRun them.")
		default:
			http.NotFound(w, r)
		}
	}))
	defer source.Close()
	home, project, extra := t.TempDir(), t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(extra, "mine"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extra, "mine", "SKILL.md"), []byte("---\nname: mine\ndescription: From an extra folder\n---\nMine."), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "merakcode.jsonc"), []byte(fmt.Sprintf(`{"skills": {"paths": [%q], "urls": [%q]}}`, filepath.ToSlash(extra), source.URL)), 0o600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{Workdir: project})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	client, err := protocol.Connect(ctx, instance.Info.Endpoint, instance.Info.Token, protocol.HelloParams{Protocol: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	var listed protocol.SkillListResult
	if err := client.Call(ctx, "skill.list", protocol.DirectoryParams{Directory: project}, &listed); err != nil {
		t.Fatal(err)
	}
	names := map[string]skill.Source{}
	for _, s := range listed.Skills {
		names[s.Name] = s.Source
	}
	if names["mine"] != skill.Global || names["pdf"] != skill.Builtin || len(listed.Sources) != 1 || listed.Sources[0] != source.URL {
		t.Fatalf("listed=%+v", listed)
	}
	var offers []skill.Offer
	if err := client.Call(ctx, "skill.discover", protocol.SkillDiscoverParams{Source: source.URL}, &offers); err != nil || len(offers) != 1 || offers[0].Name != "lint" {
		t.Fatalf("offers=%+v err=%v", offers, err)
	}
	var installed protocol.SkillInstallResult
	if err := client.Call(ctx, "skill.install", protocol.SkillInstallParams{Source: source.URL, Names: []string{"lint"}, Scope: "project", DirectoryParams: protocol.DirectoryParams{Directory: project}}, &installed); err != nil || len(installed.Installed) != 1 {
		t.Fatalf("installed=%+v err=%v", installed, err)
	}
	if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "lint", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	if err := client.Call(ctx, "skill.install", protocol.SkillInstallParams{Source: source.URL, Names: []string{"lint"}, Scope: "global"}, &installed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "skills", "lint", "SKILL.md")); err != nil {
		t.Fatalf("a global install belongs in the user's folder: %v", err)
	}
	if err := client.Call(ctx, "skill.uninstall", protocol.SkillUninstallParams{Name: "lint", Scope: "project", DirectoryParams: protocol.DirectoryParams{Directory: project}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "lint")); err == nil {
		t.Fatal("the project skill is still there")
	}
	if err := client.Call(ctx, "skill.uninstall", protocol.SkillUninstallParams{Name: "lint", Scope: "global"}, nil); err != nil {
		t.Fatal(err)
	}
}
