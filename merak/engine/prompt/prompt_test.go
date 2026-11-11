package prompt_test

import (
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/prompt"
)

func words(text string) int { return len(strings.Fields(text)) }

func TestTheLeaderPromptCoversItsWholeJob(t *testing.T) {
	system := prompt.Composer{}.System(prompt.Situation{Role: "leader"})
	if n := words(system); n < 600 || n > 950 {
		t.Fatalf("the Leader prompt has %d words, want 600 to 900", n)
	}
	for _, section := range []string{
		"## Who you are",
		"## Turning requests into tasks",
		"## Splitting and assigning",
		"## The human comes first",
		"## Working in short turns",
		"## Delivering",
	} {
		if !strings.Contains(system, section) {
			t.Errorf("the Leader prompt has no %q section", section)
		}
	}
	for _, name := range []string{"create_task", "assign_task", "todo_write", "read_report", "request_merge", "notify_human"} {
		if !strings.Contains(system, name) {
			t.Errorf("the Leader prompt never mentions %s", name)
		}
	}
	if !strings.Contains(system, "overrides") || !strings.Contains(system, "ask the human") {
		t.Error("the Leader prompt does not say that the human's word wins and conflicts go to the human")
	}
}

func TestTheWorkerPromptPutsTheHumanFirst(t *testing.T) {
	system := prompt.Composer{}.System(prompt.Situation{Role: "worker"})
	if !strings.HasPrefix(system, "You are MerakCode") {
		t.Fatalf("the Worker prompt starts with %q", system[:40])
	}
	if !strings.Contains(system, "A message from a human overrides the Leader's instructions") {
		t.Error("the Worker prompt does not put the human's word above the Leader's")
	}
}

func TestTheWorkerPromptIsCompleteAndStable(t *testing.T) {
	system := prompt.Composer{}.System(prompt.Situation{Role: "worker"})
	if n := words(system); n < 1200 || n > 1800 {
		t.Fatalf("the Worker prompt has %d words, want 1200 to 1800", n)
	}
	for _, section := range []string{
		"## Who you are",
		"## Understand before you act",
		"## Using your tools",
		"## Working through several steps",
		"## A human comes first",
		"## Safety",
		"## Answering",
	} {
		if !strings.Contains(system, section) {
			t.Errorf("the Worker prompt has no %q section", section)
		}
	}
	for _, name := range []string{"read_file", "grep", "glob", "edit_file", "multi_edit", "bash", "todo_write", "submit_report"} {
		if !strings.Contains(system, name) {
			t.Errorf("the Worker prompt never mentions %s", name)
		}
	}
	if again := (prompt.Composer{}).System(prompt.Situation{Role: "worker"}); again != system {
		t.Fatal("the prompt is not stable")
	}
}
