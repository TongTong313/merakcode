package cli_test

import (
	"bytes"
	"encoding/json"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/internal/cli"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestCloudLoginCommandUsesTheConfiguredDevelopmentHost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	peer := testcloud.New(t)
	body, _ := json.Marshal(map[string]any{"cloud": map[string]string{"endpoint": peer.Credentials().Endpoint}})
	if err := os.WriteFile(filepath.Join(home, "merakcode.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	e, err := engine.New(engine.Deps{DataDir: home, Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	host, err := server.Start(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	var output bytes.Buffer
	if code := cli.Run([]string{"cloud", "login", "--dev"}, nil, &output); code != 0 {
		t.Fatalf("exit=%d output=%s", code, output.String())
	}
	var status protocol.CloudStatus
	if err = json.Unmarshal(output.Bytes(), &status); err != nil || status.Account != "fixture-account" {
		t.Fatalf("status=%+v %v", status, err)
	}
	if bytes.Contains(output.Bytes(), []byte("fixture-secret")) {
		t.Fatal("command exposed token")
	}
	output.Reset()
	if code := cli.Run([]string{"cloud", "logout"}, nil, &output); code != 0 {
		t.Fatalf("logout=%d", code)
	}
}
