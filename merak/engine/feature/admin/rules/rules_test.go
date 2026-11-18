package rules_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/feature/admin/rules"
)

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
