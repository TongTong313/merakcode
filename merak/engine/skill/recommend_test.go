package skill_test

import (
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/skill"
)

func skills(t *testing.T, entries ...[2]string) skill.Set {
	t.Helper()
	project := t.TempDir()
	for _, entry := range entries {
		put(t, project, ".merakcode/skills/"+entry[0]+"/SKILL.md", "---\nname: "+entry[0]+"\ndescription: "+entry[1]+"\n---\nBody of "+entry[0])
	}
	set, err := skill.Discover(project, "")
	if err != nil {
		t.Fatal(err)
	}
	return set
}

func names(found []skill.Skill) string {
	var all []string
	for _, s := range found {
		all = append(all, s.Name)
	}
	return strings.Join(all, ",")
}

func TestASkillIsRecommendedWhenAMessageTalksAboutItsNameOrItsDescription(t *testing.T) {
	set := skills(t,
		[2]string{"release", "Prepare and publish a new software release with a changelog"},
		[2]string{"migrations", "Write database schema migrations safely"},
		[2]string{"translate", "翻译文档并保持术语一致"},
	)
	for _, c := range []struct{ name, message, want string }{
		{"by name", "Can you help me with the release tomorrow?", "release"},
		{"by description words", "I need to publish a changelog for the new version", "release"},
		{"chinese words", "请把这份文档翻译成英文，术语要一致", "translate"},
		{"two skills", "Write a schema migration, then prepare the release", "migrations,release"},
		{"nothing fits", "What is the weather like today?", ""},
		{"only stop words", "can you help me with the and of to a", ""},
		{"one weak word", "database", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := names(set.Recommend(c.message)); got != c.want {
				t.Fatalf("recommended %q, want %q", got, c.want)
			}
		})
	}
}

func TestAtMostThreeSkillsAreRecommendedBestFirst(t *testing.T) {
	set := skills(t,
		[2]string{"alpha", "deploy staging release notes pipeline"},
		[2]string{"beta", "deploy staging release notes"},
		[2]string{"gamma", "deploy staging release"},
		[2]string{"delta", "deploy staging"},
		[2]string{"omega", "deploy"},
	)
	got := set.Recommend("deploy staging release notes pipeline")
	if len(got) != 3 || got[0].Name != "alpha" || got[1].Name != "beta" || got[2].Name != "gamma" {
		t.Fatalf("recommended %v", names(got))
	}
}

func TestTheSameGroupIsOnlyShownOncePerSessionAndAChangedGroupIsShownAgain(t *testing.T) {
	set := skills(t,
		[2]string{"pdf", "Extract text and tables from PDF files"},
		[2]string{"docx", "Read and edit Word documents"},
	)
	recommender := set.Recommender()
	first := recommender.For("Extract the tables from this PDF file")
	if !strings.Contains(first, "- pdf:") || !strings.Contains(first, "skill tool") || strings.Contains(first, "docx") {
		t.Fatalf("first=%q", first)
	}
	if again := recommender.For("Now extract the PDF tables again"); again != "" {
		t.Fatalf("the same group came back: %q", again)
	}
	if other := recommender.For("Edit this Word document"); !strings.Contains(other, "- docx:") {
		t.Fatalf("a different skill was not recommended: %q", other)
	}
	if recommender.For("Extract tables from the PDF and edit the Word document") == "" {
		t.Fatal("a new combination of skills was suppressed")
	}
	if recommender.For("hello there") != "" {
		t.Fatal("a message that fits nothing got a recommendation")
	}
}
