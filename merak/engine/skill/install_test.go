package skill_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/skill"
)

func TestSkillsAreDiscoveredAtAnAddressAndInstalledIntoTheProjectAndRemovedAgain(t *testing.T) {
	files := map[string]string{
		"/index.json":      `{"skills":[{"name":"lint","description":"Run linters","files":["SKILL.md","check.sh"]},{"name":"deploy","description":"Ship it","files":["SKILL.md"]}]}`,
		"/lint/SKILL.md":   "---\nname: lint\ndescription: Run linters\n---\nRun the linters.",
		"/lint/check.sh":   "echo check",
		"/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship it\n---\nDeploy.",
	}
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, body)
	}))
	defer host.Close()
	ctx := t.Context()

	found, err := skill.DiscoverSource(ctx, host.URL)
	if err != nil || len(found) != 2 || found[0].Name != "deploy" || found[1].Name != "lint" {
		t.Fatalf("found=%+v err=%v", found, err)
	}
	project := t.TempDir()
	installed, err := skill.Install(ctx, host.URL, []string{"lint"}, filepath.Join(project, ".merakcode", "skills"))
	if err != nil || len(installed) != 1 || installed[0] != "lint" {
		t.Fatalf("installed=%v err=%v", installed, err)
	}
	for _, name := range []string{"SKILL.md", "check.sh"} {
		if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "lint", name)); err != nil {
			t.Fatalf("%s was not installed: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(project, ".merakcode", "skills", "deploy")); err == nil {
		t.Fatal("a skill that was not chosen was installed")
	}
	set, err := skill.Discover(project, "")
	if err != nil {
		t.Fatal(err)
	}
	if body, files, ok := set.Read("lint"); !ok || body != "Run the linters." || len(files) != 1 {
		t.Fatalf("body=%q files=%v ok=%v", body, files, ok)
	}
	if _, err := skill.Install(ctx, host.URL, []string{"missing"}, t.TempDir()); err == nil {
		t.Fatal("a skill the source does not have was installed")
	}
	files["/lint/SKILL.md"] = "---\nname: other\ndescription: Renamed\n---\nBody"
	if _, err := skill.Install(ctx, host.URL, []string{"lint"}, t.TempDir()); err == nil {
		t.Fatal("a skill whose SKILL.md names another skill was installed")
	}
	files["/index.json"] = `{"skills":[{"name":"evil","description":"x","files":["../../escape.txt","SKILL.md"]}]}`
	if _, err := skill.Install(ctx, host.URL, []string{"evil"}, t.TempDir()); err == nil {
		t.Fatal("a file path that leaves the skill folder was installed")
	}

	root := filepath.Join(project, ".merakcode", "skills")
	if err := skill.Uninstall(root, "lint"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "lint")); err == nil {
		t.Fatal("the skill folder is still there")
	}
	if err := skill.Uninstall(root, "lint"); err == nil {
		t.Fatal("uninstalling a missing skill did not fail")
	}
	if err := skill.Uninstall(root, "../outside"); err == nil {
		t.Fatal("a name outside the skills folder was uninstalled")
	}
}

func TestSkillsAreFoundInAGitRepositoryByShallowClone(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.name", "Fixture")
	run("config", "user.email", "fixture@example.invalid")
	put(t, repo, "skills/first/SKILL.md", "---\nname: first\ndescription: One\n---\nFirst body")
	put(t, repo, "skills/first/data.txt", "data")
	put(t, repo, "deeper/second/SKILL.md", "---\nname: second\ndescription: Two\n---\nSecond body")
	put(t, repo, "README.md", "not a skill")
	run("add", ".")
	run("commit", "-m", "skills")

	ctx := t.Context()
	cache := t.TempDir()
	source := "file://" + filepath.ToSlash(repo)
	if !strings.HasPrefix(source, "file:///") {
		source = "file:///" + strings.TrimPrefix(filepath.ToSlash(repo), "/")
	}
	found, err := skill.DiscoverGit(ctx, source, cache, "")
	if err != nil || len(found) != 2 || found[0].Name != "first" || found[1].Name != "second" {
		t.Fatalf("found=%+v err=%v", found, err)
	}
	target := filepath.Join(t.TempDir(), "skills")
	installed, err := skill.InstallGit(ctx, source, cache, "", []string{"first", "second"}, target)
	if err != nil || len(installed) != 2 {
		t.Fatalf("installed=%v err=%v", installed, err)
	}
	for _, name := range []string{"first/SKILL.md", "first/data.txt", "second/SKILL.md"} {
		if _, err := os.Stat(filepath.Join(target, filepath.FromSlash(name))); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "first", ".git")); err == nil {
		t.Fatal("the clone's .git folder was copied into the skill")
	}
	if _, err := skill.DiscoverGit(ctx, "file:///does/not/exist", cache, ""); err == nil {
		t.Fatal("a repository that does not exist was cloned")
	}
}
