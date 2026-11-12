package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
)

func doctorReport(t *testing.T, args ...string) (int, doctorResult, string) {
	t.Helper()
	var out bytes.Buffer
	code := Run(append([]string{"doctor", "--json"}, args...), strings.NewReader(""), &out)
	var report doctorResult
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("doctor --json is not JSON (code %d): %v\n%s", code, err, out.String())
	}
	return code, report, out.String()
}

func doctorStatus(report doctorResult, name string) (doctorCheck, bool) {
	for _, check := range report.Checks {
		if check.Name == name {
			return check, true
		}
	}
	return doctorCheck{}, false
}

func TestDoctorFailsTheModelItemWithoutADefaultModelAndPassesTheRest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": fake.New(t)}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()

	code, report, _ := doctorReport(t)
	if code != 3 || report.OK {
		t.Fatalf("code=%d ok=%v", code, report.OK)
	}
	for _, name := range []string{"daemon", "data", "model", "sandbox", "git", "mcp"} {
		if _, found := doctorStatus(report, name); !found {
			t.Errorf("no %s check in %+v", name, report.Checks)
		}
	}
	for _, check := range report.Checks {
		if check.Name == "model" {
			if check.Status != "fail" || check.Code == "" {
				t.Errorf("model check = %+v", check)
			}
			continue
		}
		if check.Status == "fail" {
			t.Errorf("%s check failed: %+v", check.Name, check)
		}
	}
	daemon, _ := doctorStatus(report, "daemon")
	if daemon.Status != "ok" {
		t.Errorf("daemon check = %+v", daemon)
	}
	if sessions := listedSessions(t); sessions != 0 {
		t.Errorf("doctor left %d sessions behind", sessions)
	}
}

func listedSessions(t *testing.T) int {
	t.Helper()
	var out bytes.Buffer
	if code := Run([]string{"session", "list"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("session list=%d %s", code, out.String())
	}
	var sessions []json.RawMessage
	if err := json.Unmarshal(out.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	return len(sessions)
}

func TestDoctorPassesEveryItemWhenTheDefaultModelAnswers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	e, err := engine.New(engine.Deps{Workdir: home, Providers: map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "ok"}, fake.Reply{Text: "ok"}, fake.Reply{Text: "ok"}, fake.Reply{Text: "ok"}, fake.Reply{Text: "ok"}, fake.Reply{Text: "ok"})}})
	// every turn may ask the model once more for a conversation title
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	// the server applies the configuration at start, so the default model is set after it
	e.SetDefaultModel("fake", "fixture", "")

	code, report, _ := doctorReport(t)
	if code != 0 || !report.OK {
		t.Fatalf("code=%d report=%+v", code, report)
	}
	if check, _ := doctorStatus(report, "model"); check.Status != "ok" || !strings.Contains(check.Detail, "fake/fixture") {
		t.Errorf("model check = %+v", check)
	}

	for language, wants := range map[string][]string{"en": {"Engine", "Default model", "Everything needed works"}, "zh": {"引擎", "默认模型", "全部正常"}} {
		var out bytes.Buffer
		if code := Run([]string{"--lang", language, "doctor"}, strings.NewReader(""), &out); code != 0 {
			t.Fatalf("%s: code=%d output=%s", language, code, out.String())
		}
		for _, want := range wants {
			if !strings.Contains(out.String(), want) {
				t.Errorf("%s output lacks %q:\n%s", language, want, out.String())
			}
		}
	}
}

func TestDoctorTextIsInBothLanguages(t *testing.T) {
	result := doctorResult{OK: false, Checks: []doctorCheck{
		{Name: "daemon", Status: "ok", Detail: "pid 1"},
		{Name: "model", Status: "fail", Code: "MRK-2001"},
		{Name: "sandbox", Status: "warn", Detail: "x"},
		{Name: "mcp", Status: "skip"},
	}}
	for language, wants := range map[string][]string{
		"en": {"Engine", "Default model", "MRK-2001", "problem", "Sandbox", "MCP servers"},
		"zh": {"引擎", "默认模型", "MRK-2001", "个问题", "沙箱", "MCP 服务器"},
	} {
		var out bytes.Buffer
		if err := writeDoctor(&out, &renderer{language: language}, result); err != nil {
			t.Fatal(err)
		}
		for _, want := range wants {
			if !strings.Contains(out.String(), want) {
				t.Errorf("%s output lacks %q:\n%s", language, want, out.String())
			}
		}
	}
	var out bytes.Buffer
	if err := writeDoctor(&out, &renderer{language: "en"}, doctorResult{OK: true, Checks: []doctorCheck{{Name: "daemon", Status: "ok"}}}); err != nil || !strings.Contains(out.String(), "Everything needed works") {
		t.Errorf("all ok: %v %q", err, out.String())
	}
	out.Reset()
	if err := writeDoctor(&out, &renderer{language: "zh"}, doctorResult{OK: true, Checks: []doctorCheck{{Name: "daemon", Status: "ok"}}}); err != nil || !strings.Contains(out.String(), "全部正常") {
		t.Errorf("all ok zh: %v %q", err, out.String())
	}
}

func TestMCPChecksReportEachServerByItsStatus(t *testing.T) {
	for _, test := range []struct {
		name     string
		statuses []mcpState
		want     string
		detail   []string
	}{
		{"none configured", nil, "ok", nil},
		{"connected", []mcpState{{Name: "docs", Status: "connected", Tools: 3}}, "ok", []string{"docs"}},
		{"disabled only", []mcpState{{Name: "docs", Status: "disabled"}}, "ok", nil},
		{"needs sign in", []mcpState{{Name: "docs", Status: "connected"}, {Name: "mail", Status: "needs_auth"}}, "warn", []string{"mail"}},
		{"failed", []mcpState{{Name: "docs", Status: "connected"}, {Name: "broken", Status: "failed", Code: "MRK-5010"}}, "fail", []string{"broken", "MRK-5010"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			check := mcpCheck(test.statuses)
			if check.Name != "mcp" || check.Status != test.want {
				t.Fatalf("check=%+v want %s", check, test.want)
			}
			for _, want := range test.detail {
				if !strings.Contains(check.Detail+check.Code, want) {
					t.Errorf("check %+v lacks %q", check, want)
				}
			}
		})
	}
}

func TestDoctorRejectsArguments(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	var out bytes.Buffer
	if code := Run([]string{"doctor", "extra"}, strings.NewReader(""), &out); code != 2 {
		t.Fatalf("code=%d", code)
	}
}
