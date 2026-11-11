package cli

import (
	"bytes"
	"fmt"
	"net/url"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
)

func TestStatusSaysWhetherTheDaemonRunsAndWhatItHolds(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	t.Setenv("MERAKCODE_LANG", "en")
	var output bytes.Buffer
	if code := Run([]string{"status"}, strings.NewReader(""), &output); code != 1 || !strings.Contains(output.String(), "not running") {
		t.Fatalf("before the daemon runs: code=%d output=%q", code, output.String())
	}
	e, err := engine.New(engine.Deps{Workdir: home})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	parsed, _ := url.Parse(instance.Info.Endpoint)
	output.Reset()
	if code := Run([]string{"status"}, strings.NewReader(""), &output); code != 0 {
		t.Fatalf("status=%d %s", code, output.String())
	}
	for _, want := range []string{"running", fmt.Sprint("pid: ", instance.Info.PID), "port: " + parsed.Port(), "root: " + home, "clients: 1"} {
		if !strings.Contains(output.String(), want) {
			t.Errorf("status lacks %q:\n%s", want, output.String())
		}
	}
}
