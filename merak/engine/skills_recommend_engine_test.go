package engine_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
)

func TestAProjectSkillIsRecommendedAfterAMessageThatFitsItAndNotRepeated(t *testing.T) {
	project := t.TempDir()
	dir := filepath.Join(project, ".merakcode", "skills", "pdf")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: pdf\ndescription: Extract tables and text from PDF files\n---\nUse the pdf tools."), 0o600); err != nil {
		t.Fatal(err)
	}
	var inputs []string
	record := func(req model.Request) error {
		var text strings.Builder
		for _, part := range req.Messages[len(req.Messages)-1].Parts {
			text.WriteString(part.Text + "\n")
		}
		inputs = append(inputs, text.String())
		return nil
	}
	provider := fake.New(t,
		fake.Reply{Text: "Sure.", Expect: record},
		fake.Reply{Text: "Again.", Expect: record},
		fake.Reply{Text: "Fine.", Expect: record},
	)
	e, err := engine.New(engine.Deps{Workdir: project, Providers: map[string]model.Provider{"fake": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	id, err := e.CreateSession(t.Context(), engine.SessionOptions{Provider: "fake", Workdir: project, Mode: permission.ModeAsk})
	if err != nil {
		t.Fatal(err)
	}
	r := &chatRig{t: t, e: e, ctx: t.Context(), dir: project, id: id}
	r.say("帮我把这个 PDF 的表格抽出来")
	r.say("Extract the tables from that PDF file again")
	r.say("What is two plus two?")
	if !strings.Contains(inputs[0], "- pdf: Extract tables and text from PDF files") || !strings.Contains(inputs[0], "skill tool") {
		t.Fatalf("the first message has no recommendation:\n%s", inputs[0])
	}
	for i, input := range inputs[1:] {
		if strings.Contains(input, "Skills that may help") {
			t.Fatal(fmt.Sprintf("message %d repeated the recommendation:\n%s", i+2, input))
		}
	}
	state := r.state()
	var stored strings.Builder
	for _, message := range state.Messages {
		for _, part := range message.Parts {
			stored.WriteString(part.Text)
		}
	}
	if !strings.Contains(stored.String(), "Skills that may help") {
		t.Fatal("the recommendation is not part of the conversation history")
	}
}
