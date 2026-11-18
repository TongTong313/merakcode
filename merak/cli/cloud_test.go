package cli_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TongTong313/merakcode/merak/cli"
	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
)

func TestCloudLoginCommandUsesTheConfiguredDevelopmentHost(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	peer := testcloud.New(t)
	body, _ := json.Marshal(map[string]any{"cloud": map[string]string{"endpoint": peer.Credentials().Endpoint}})
	if err := os.WriteFile(filepath.Join(home, "merakcode.json"), body, 0600); err != nil {
		t.Fatal(err)
	}
	deps := enginetest.Deps(t)
	deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps.DataDir = home
	deps.Dirs = enginetest.Dirs(t, deps.DataDir)
	deps.Workdir = t.TempDir()
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	host, err := server.StartWith(e, server.Options{Data: filepath.Join(home, "data"), Config: home, Address: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	var output bytes.Buffer
	if code := cli.Run([]string{"cloud", "login", "--dev"}, nil, &output); code != 0 {
		t.Fatalf("exit=%d output=%s", code, output.String())
	}
	var status wire.CloudStatus
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
