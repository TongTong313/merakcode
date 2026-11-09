package sandbox_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/process"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

func TestCancelledLaunchDoesNotReturnACommand(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	launcher := &sandbox.Launcher{Disabled: true}
	cmd, err := launcher.Command(ctx, sandbox.Profile{}, os.Args[0], "-test.run=^TestSandboxChild$")
	if cmd != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled launch returned command %v and error %v", cmd, err)
	}
}

func TestEnvironmentWhitelistReachesTheRealChild(t *testing.T) {
	profile := sandbox.Profile{EnvAllow: []string{"SystemRoot", "MERAKCODE_TEST_ALLOWED"}}
	cmd := process.Command(context.Background(), t.TempDir(), os.Args[0], "-test.run=^TestSandboxChild$", "--", "environment", "unused")
	cmd.Env = profile.Environment([]string{
		"SystemRoot=" + os.Getenv("SystemRoot"),
		"MERAKCODE_TEST_ALLOWED=old",
		"MERAKCODE_TEST_SECRET=not-for-child",
		"MERAKCODE_TEST_ALLOWED=visible",
		"MERAKCODE_TEST_ALLOWED_SUFFIX=not-for-child",
	})
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var environment []string
	if err := json.Unmarshal(output, &environment); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"SystemRoot=" + os.Getenv("SystemRoot"): true, "MERAKCODE_TEST_ALLOWED=visible": true}
	if len(environment) != len(want) {
		t.Fatalf("environment contains %d entries, want %d", len(environment), len(want))
	}
	for _, entry := range environment {
		if !want[entry] {
			t.Fatal("child received an unapproved environment entry")
		}
	}
}

func TestTakeoverRunsWithoutFileOrEnvironmentRestrictions(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MERAKCODE_SANDBOX_TEST_VALUE", "visible")
	launcher := &sandbox.Launcher{Disabled: true}
	path := filepath.Join(root, "outside.txt")
	cmd, err := launcher.Command(context.Background(), sandbox.Profile{}, os.Args[0], "-test.run=^TestSandboxChild$", "--", "write-env", path)
	if err != nil {
		t.Fatal(err)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("command: %v: %s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "visible" {
		t.Fatalf("takeover output = %q, %v", data, err)
	}
}

func TestTakeoverStatusReportsThatTheSandboxIsDisabled(t *testing.T) {
	launcher := &sandbox.Launcher{Disabled: true}
	status := launcher.Status(t.Context(), sandbox.Profile{})
	body, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var view struct {
		Disabled bool `json:"disabled"`
	}
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatal(err)
	}
	if !view.Disabled || status.Available || status.Backend != "none" || status.Network != "none" {
		t.Fatalf("takeover status=%s", body)
	}
}

func TestSandboxChild(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" || len(os.Args) < i+3 {
			continue
		}
		var err error
		switch os.Args[i+1] {
		case "write-env":
			err = os.WriteFile(os.Args[i+2], []byte(os.Getenv("MERAKCODE_SANDBOX_TEST_VALUE")), 0o600)
		case "environment":
			err = json.NewEncoder(os.Stdout).Encode(os.Environ())
		case "read":
			var data []byte
			data, err = os.ReadFile(os.Args[i+2])
			if err == nil {
				_, err = os.Stdout.Write(data)
			}
		case "fetch", "fetch-proxy":
			client := &http.Client{Timeout: time.Second}
			if os.Args[i+1] == "fetch-proxy" {
				proxyURL, parseErr := url.Parse(os.Getenv("HTTP_PROXY"))
				if parseErr != nil || proxyURL.Scheme != "http" || proxyURL.Host == "" {
					t.Fatal("missing valid sandbox proxy")
				}
				client.Transport = &http.Transport{Proxy: http.ProxyURL(proxyURL)}
			}
			var response *http.Response
			response, err = client.Get(os.Args[i+2])
			if err == nil {
				if response.StatusCode != http.StatusOK {
					response.Body.Close()
					t.Fatalf("unexpected HTTP status %d", response.StatusCode)
				}
				_, err = io.Copy(os.Stdout, response.Body)
				response.Body.Close()
			}
		case "namespaces":
			links := make(map[string]string)
			for _, name := range []string{"user", "net"} {
				links[name], err = os.Readlink("/proc/self/ns/" + name)
				if err != nil {
					break
				}
			}
			if err == nil {
				err = json.NewEncoder(os.Stdout).Encode(links)
			}
		case "wait":
			if _, err := os.Stdout.WriteString("ready\n"); err != nil {
				t.Fatal(err)
			}
			for {
				time.Sleep(time.Hour)
			}
		case "spawn-wait":
			child := process.Command(context.Background(), "", os.Args[0], "-test.run=^TestSandboxChild$", "--", "wait", "unused")
			child.Stdout, child.Stderr = os.Stdout, os.Stderr
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			fmt.Printf("child:%d parent:%d\n", child.Process.Pid, os.Getpid())
			for {
				time.Sleep(time.Hour)
			}
		default:
			t.Fatal("unknown child operation")
		}
		if err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
}
