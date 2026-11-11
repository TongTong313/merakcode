package rules_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/rules"
)

func write(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func repository(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-b", "main")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	return root
}

func TestRuleFilesAreFoundFromTheWorkspaceUpToTheGitRootInBothFolders(t *testing.T) {
	root := repository(t)
	work := filepath.Join(root, "packages", "app")
	write(t, root, "AGENTS.md", "Root instructions")
	write(t, root, ".merakcode/rules/always.mdc", "---\ndescription: Style\nalwaysApply: true\n---\nUse tabs.")
	write(t, root, ".merakcode/rule/deep/glob.mdc", "---\ndescription: TypeScript\nglobs: [\"**/*.ts\", \"*.tsx\"]\n---\nPrefer const.")
	write(t, root, ".cursor/rules/described.mdc", "---\ndescription: How we write migrations\n---\nName files by date.")
	write(t, work, ".merakcode/rules/near.mdc", "---\nalwaysApply: true\n---\nNear rule.")
	write(t, work, "sub/.merakcode/rules/ignored.mdc", "---\nalwaysApply: true\n---\nMust not be found.")
	write(t, root, ".merakcode/rules/notes.txt", "not a rule")

	set, err := rules.Load(t.Context(), work)
	if err != nil {
		t.Fatal(err)
	}
	if set.Instructions != "" {
		t.Errorf("AGENTS.md is read at the workspace root only, got %q", set.Instructions)
	}
	names := map[string]rules.Rule{}
	for _, rule := range set.Rules {
		names[rule.Name] = rule
	}
	if len(names) != 4 || names["always"].Kind() != rules.Always || names["near"].Kind() != rules.Always || names["deep/glob"].Kind() != rules.Matching || names["described"].Kind() != rules.Described {
		t.Fatalf("rules=%+v", names)
	}
	if got := names["deep/glob"].Globs; len(got) != 2 || got[0] != "**/*.ts" || got[1] != "*.tsx" {
		t.Errorf("globs=%v", got)
	}
	if names["always"].Body != "Use tabs." || names["described"].Description != "How we write migrations" {
		t.Errorf("always=%+v described=%+v", names["always"], names["described"])
	}
	if _, ok := names["ignored"]; ok {
		t.Error("a rule in a subfolder of the workspace was scanned")
	}

	atRoot, err := rules.Load(t.Context(), root)
	if err != nil || atRoot.Instructions != "Root instructions" {
		t.Fatalf("instructions=%q err=%v", atRoot.Instructions, err)
	}
}

func TestAnOversizedRuleIsCutAndSaysSo(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".merakcode/rules/big.mdc", "---\nalwaysApply: true\n---\n"+strings.Repeat("x", 40*1024))
	set, err := rules.Load(t.Context(), root)
	if err != nil || len(set.Rules) != 1 {
		t.Fatalf("rules=%+v err=%v", set.Rules, err)
	}
	rule := set.Rules[0]
	if !rule.Truncated || len(rule.Body) > 32*1024+200 || !strings.Contains(rule.Body, "truncated") {
		t.Fatalf("truncated=%v length=%d", rule.Truncated, len(rule.Body))
	}
}

func TestAMatchingRuleIsAttachedOncePerSessionToAFileItFits(t *testing.T) {
	root := t.TempDir()
	write(t, root, ".merakcode/rules/ts.mdc", "---\nglobs: [\"src/**/*.ts\"]\n---\nPrefer const.")
	write(t, root, ".merakcode/rules/md.mdc", "---\nglobs: [\"*.md\"]\n---\nWrite short docs.")
	set, err := rules.Load(t.Context(), root)
	if err != nil {
		t.Fatal(err)
	}
	attach := set.Attacher(root)
	if got := attach(filepath.Join(root, "src", "deep", "a.ts")); !strings.Contains(got, "Prefer const.") || strings.Contains(got, "Write short docs.") {
		t.Fatalf("first read: %q", got)
	}
	if got := attach(filepath.Join(root, "src", "b.ts")); got != "" {
		t.Fatalf("the same rule was attached twice: %q", got)
	}
	if got := attach(filepath.Join(root, "README.md")); !strings.Contains(got, "Write short docs.") {
		t.Fatalf("README: %q", got)
	}
	if got := attach(filepath.Join(root, "other.txt")); got != "" {
		t.Fatalf("a rule that fits nothing was attached: %q", got)
	}
	if got := attach(filepath.Join(t.TempDir(), "src", "x.ts")); got != "" {
		t.Fatalf("a file outside the workspace got a rule: %q", got)
	}
}

func TestThePromptPutsPersonalRulesBeforeProjectRulesAndListsTheDescribedOnes(t *testing.T) {
	root := t.TempDir()
	write(t, root, "AGENTS.md", "Project instructions")
	write(t, root, ".merakcode/rules/a.mdc", "---\nalwaysApply: true\n---\nAlways apply me.")
	write(t, root, ".merakcode/rules/d.mdc", "---\ndescription: Database advice\n---\nUse transactions.")
	set, err := rules.Load(t.Context(), root)
	if err != nil {
		t.Fatal(err)
	}
	sections := set.Sections([]string{"Personal rule one", "Personal rule two"})
	text := strings.Join(sections, "\n\n")
	order := []string{"Personal rule one", "Personal rule two", "Project instructions", "Always apply me.", "Database advice"}
	last := -1
	for _, want := range order {
		at := strings.Index(text, want)
		if at <= last {
			t.Fatalf("%q is missing or out of order in:\n%s", want, text)
		}
		last = at
	}
	if strings.Contains(text, "Use transactions.") {
		t.Fatal("the body of a described rule is in the prompt")
	}
	body, ok := set.Lookup("d")
	if !ok || body != "Use transactions." {
		t.Fatalf("lookup=%q %v", body, ok)
	}
	if _, ok := set.Lookup("a"); ok {
		t.Fatal("an always-on rule can be looked up")
	}
}

func TestRuleFilesAreWrittenAndDeletedInsideTheRulesFolder(t *testing.T) {
	root := t.TempDir()
	path, err := rules.WriteFile(root, "style", "---\nalwaysApply: true\n---\nHello")
	if err != nil || !strings.HasSuffix(filepath.ToSlash(path), ".merakcode/rules/style.mdc") {
		t.Fatalf("path=%q err=%v", path, err)
	}
	if body, _ := os.ReadFile(path); string(body) != "---\nalwaysApply: true\n---\nHello" {
		t.Fatalf("file=%q", body)
	}
	for _, bad := range []string{"../escape", "a/../../b", "", "with space/x", `back\slash`, "x.txt/.."} {
		if _, err := rules.WriteFile(root, bad, "x"); err == nil {
			t.Errorf("name %q was accepted", bad)
		}
	}
	if err := rules.DeleteFile(root, "style"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("the rule file is still there")
	}
	if err := rules.DeleteFile(root, "style"); err == nil {
		t.Fatal("deleting a missing rule did not fail")
	}
}
