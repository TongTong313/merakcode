package task_test

import (
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine/task"
)

func TestTitleFromTakesTheFirstLineCappedAt80Characters(t *testing.T) {
	long := strings.Repeat("字", 100)
	for _, c := range []struct{ name, text, want string }{
		{"single line", "Fix the login", "Fix the login"},
		{"first line only", "Fix the login\nthen the logout", "Fix the login"},
		{"leading blank lines", "\n\n  Fix it  \nmore", "Fix it"},
		{"capped by characters", long, strings.Repeat("字", 80)},
		{"empty text", "  \n ", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := task.TitleFrom(c.text); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}
