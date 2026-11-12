package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// sandboxEngine hosts a real engine whose sandbox state folder is the one merak serve would use.
func sandboxEngine(t *testing.T) (home string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	e, err := engine.New(engine.Deps{Workdir: home, DataDir: filepath.Join(home, "data")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Close() })
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = instance.Close() })
	return home
}

func TestSandboxStatusAgreesWithTheSandboxStatusMethod(t *testing.T) {
	home := sandboxEngine(t)
	workdir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	client, err := connectEngine(ctx, filepath.Join(home, "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var want json.RawMessage
	if err := client.Call(ctx, "sandbox.status", protocol.SandboxStatusParams{Workdir: workdir}, &want); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := Run([]string{"sandbox", "status", "--json"}, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("code=%d output=%s", code, out.String())
	}
	var got, expected map[string]any
	if json.Unmarshal(out.Bytes(), &got) != nil || json.Unmarshal(want, &expected) != nil {
		t.Fatalf("not JSON: %s / %s", out.String(), want)
	}
	for _, key := range []string{"available", "backend", "network", "disabled", "waitingAccount", "reason"} {
		if jsonString(got[key]) != jsonString(expected[key]) {
			t.Errorf("%s: command=%v method=%v", key, got[key], expected[key])
		}
	}

	available, _ := expected["available"].(bool)
	backend, _ := expected["backend"].(string)
	for language, markers := range map[string][3]string{"en": {"Sandbox: on (" + backend + ")", "Sandbox: not set up", "Sandbox: not available"}, "zh": {"沙箱：已开启（" + backend + "）", "沙箱：尚未初始化", "沙箱：不可用"}} {
		out.Reset()
		if code := Run([]string{"--lang", language, "sandbox", "status"}, strings.NewReader(""), &out); code != 0 {
			t.Fatalf("%s: code=%d output=%s", language, code, out.String())
		}
		marker := markers[2]
		if available {
			marker = markers[0]
		} else if backend == "windows-account" {
			marker = markers[1]
		}
		if !strings.Contains(out.String(), marker) {
			t.Errorf("%s: output %q lacks %q (available=%v)", language, out.String(), marker, available)
		}
	}
}

func TestSandboxStatusTextCoversEveryConclusionInBothLanguages(t *testing.T) {
	for _, test := range []struct {
		name   string
		status sandboxStatus
		en, zh []string
	}{
		{"on", sandboxStatus{Available: true, Backend: "landlock", Network: "none"}, []string{"Sandbox: on (landlock)"}, []string{"沙箱：已开启（landlock）"}},
		{"partial", sandboxStatus{Available: true, Backend: "windows-account", Limits: []string{"loopback-open", "udp-open"}}, []string{"cannot enforce", "localhost", "UDP"}, []string{"无法强制", "本机", "UDP"}},
		{"disabled", sandboxStatus{Disabled: true, Backend: "none"}, []string{"Sandbox: off"}, []string{"沙箱：已关闭"}},
		{"waiting", sandboxStatus{WaitingAccount: true, Backend: "windows-account"}, []string{"waiting"}, []string{"等待"}},
		{"needs setup", sandboxStatus{Backend: "windows-account", Reason: "MRK-5004"}, []string{"Sandbox: not set up", "merak sandbox setup"}, []string{"沙箱：尚未初始化", "merak sandbox setup"}},
		{"unavailable", sandboxStatus{Backend: "seatbelt", Reason: "MRK-5004"}, []string{"Sandbox: not available", "MRK-5004"}, []string{"沙箱：不可用", "MRK-5004"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			for language, wants := range map[string][]string{"en": test.en, "zh": test.zh} {
				var out bytes.Buffer
				if err := writeSandboxStatus(&out, &renderer{language: language}, test.status); err != nil {
					t.Fatal(err)
				}
				for _, want := range wants {
					if !strings.Contains(out.String(), want) {
						t.Errorf("%s output lacks %q:\n%s", language, want, out.String())
					}
				}
			}
		})
	}
}

func TestSandboxSetupExplainsWhySystemsOtherThanWindowsHaveNothingToSetUp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("setup asks Windows for administrator approval")
	}
	sandboxEngine(t)
	var out bytes.Buffer
	if code := Run([]string{"sandbox", "setup"}, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "[MRK-5004]") {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
}

func TestSandboxResetWithoutAPoolChangesNothing(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	for language, want := range map[string]string{"en": "Nothing to reset", "zh": "没有需要重置的内容"} {
		var out bytes.Buffer
		if code := Run([]string{"--lang", language, "sandbox", "reset"}, strings.NewReader(""), &out); code != 0 || !strings.Contains(out.String(), want) {
			t.Errorf("%s: code=%d output=%q", language, code, out.String())
		}
	}
}

func TestSandboxResetNeedsTheEngineStopped(t *testing.T) {
	home := sandboxEngine(t)
	if err := os.MkdirAll(filepath.Join(home, "data", "sandbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "data", "sandbox", "accounts.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := Run([]string{"sandbox", "reset"}, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "[MRK-5013]") || !strings.Contains(out.String(), "merak stop") {
		t.Fatalf("code=%d output=%q", code, out.String())
	}
	if _, err := os.Stat(filepath.Join(home, "data", "sandbox", "accounts.json")); err != nil {
		t.Fatalf("reset touched the pool while the engine ran: %v", err)
	}
}

func TestSandboxRejectsUnknownSubcommands(t *testing.T) {
	t.Setenv("MERAKCODE_HOME", t.TempDir())
	for _, args := range [][]string{{"sandbox"}, {"sandbox", "explode"}, {"sandbox", "status", "extra"}, {"sandbox", "reset", "extra"}} {
		var out bytes.Buffer
		if code := Run(args, strings.NewReader(""), &out); code != 2 {
			t.Errorf("%v: code=%d", args, code)
		}
	}
}

func jsonString(value any) string {
	body, _ := json.Marshal(value)
	return string(body)
}
