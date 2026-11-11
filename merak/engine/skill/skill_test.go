package skill_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/skill"
)

func put(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSkillsAreFoundInTheProjectTheGlobalFolderAndTheBinaryWithTheProjectFirst(t *testing.T) {
	project, global, extra := t.TempDir(), t.TempDir(), t.TempDir()
	put(t, project, ".merakcode/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship the app\n---\nRun the deploy script.")
	put(t, project, ".merakcode/skills/deploy/scripts/run.sh", "echo hi")
	put(t, project, ".merakcode/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Project version of pdf\n---\nProject pdf body.")
	put(t, global, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Take notes\n---\nWrite notes.")
	put(t, global, "skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Global version of pdf\n---\nGlobal pdf body.")
	put(t, extra, "tidy/SKILL.md", "---\nname: tidy\ndescription: Tidy up\n---\nTidy.")
	put(t, project, ".merakcode/skills/broken/SKILL.md", "no front matter at all")

	set, err := skill.Discover(project, global, extra)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]skill.Skill{}
	for _, s := range set.Skills {
		by[s.Name] = s
	}
	for _, name := range []string{"deploy", "notes", "tidy", "pdf", "docx", "excel"} {
		if _, ok := by[name]; !ok {
			t.Errorf("skill %q is missing (have %v)", name, set.Names())
		}
	}
	if by["pdf"].Source != skill.Project || by["pdf"].Description != "Project version of pdf" {
		t.Errorf("a project skill must win over the global and built-in ones: %+v", by["pdf"])
	}
	if by["notes"].Source != skill.Global || by["tidy"].Source != skill.Global || by["docx"].Source != skill.Builtin {
		t.Errorf("sources: notes=%v tidy=%v docx=%v", by["notes"].Source, by["tidy"].Source, by["docx"].Source)
	}
	if _, ok := by["broken"]; ok {
		t.Error("a skill without a front matter was listed")
	}
	if len(set.Problems) != 1 || !strings.Contains(set.Problems[0], "broken") {
		t.Errorf("problems=%v", set.Problems)
	}

	body, files, ok := set.Read("deploy")
	if !ok || body != "Run the deploy script." || len(files) != 1 || files[0] != filepath.Join(project, ".merakcode", "skills", "deploy", "scripts", "run.sh") {
		t.Fatalf("body=%q files=%v ok=%v", body, files, ok)
	}
	if body, files, ok := set.Read("docx"); !ok || !strings.Contains(body, "Word") || len(files) != 0 {
		t.Fatalf("a built-in skill: %q %v %v", body, files, ok)
	}
	if _, _, ok := set.Read("missing"); ok {
		t.Fatal("a missing skill was read")
	}
}

func TestThePromptSectionListsEverySkillInAStableOrderAndTheSkillToolReturnsItsBody(t *testing.T) {
	project := t.TempDir()
	put(t, project, ".merakcode/skills/zeta/SKILL.md", "---\nname: zeta\ndescription: Last one\n---\nZ body")
	put(t, project, ".merakcode/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First one\n---\nA body")
	set, err := skill.Discover(project, "")
	if err != nil {
		t.Fatal(err)
	}
	section := set.Section()
	if !strings.Contains(section, "- alpha: First one") || !strings.Contains(section, "- zeta: Last one") || strings.Index(section, "alpha") > strings.Index(section, "zeta") {
		t.Fatalf("section:\n%s", section)
	}
	again, _ := skill.Discover(project, "")
	if again.Section() != section {
		t.Fatal("the section changes between two discoveries of the same folder")
	}
	if (skill.Set{}).Section() != "" {
		t.Fatal("an empty set has a section")
	}
}

func TestTheBuiltInLoopSkillTellsHowToTurnAPeriodIntoACronExpression(t *testing.T) {
	set, err := skill.Discover(t.TempDir(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	body, _, ok := set.Read("loop")
	if !ok {
		t.Fatalf("the loop skill is missing (have %v)", set.Names())
	}
	for _, want := range []string{"schedule_create", "schedule_list", "schedule_delete", "0 9 * * *", "*/5 * * * *", "0 9 * * 1-5", "five fields"} {
		if !strings.Contains(body, want) {
			t.Errorf("the loop skill does not mention %q", want)
		}
	}
	for _, found := range set.Skills {
		if found.Name == "loop" && found.Source != skill.Builtin {
			t.Errorf("source = %v", found.Source)
		}
	}
}
