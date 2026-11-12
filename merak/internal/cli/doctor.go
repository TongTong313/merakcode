package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// doctorCheck is the result of one item. Status is ok, warn (it works but something is missing), fail or skip (it
// could not be checked because an earlier item failed). Code is the MRK code of a failure.
type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
	Code   string `json:"code,omitempty"`
}

type doctorResult struct {
	OK     bool          `json:"ok"`
	Checks []doctorCheck `json:"checks"`
}

type mcpState struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Tools  int    `json:"tools"`
	Code   string `json:"code,omitempty"`
}

// doctorCommand runs merak doctor: it checks the engine, the data folder, the default model, the sandbox, git and the
// configured MCP servers, one line each, and exits with 1 when an item failed. An engine that is not running is
// started the way every other command starts it.
func doctorCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	machine := flags.Bool("json", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result := runDoctor(ctx)
	if *machine {
		if json.NewEncoder(output).Encode(result) != nil {
			return 1
		}
	} else if writeDoctor(output, ui, result) != nil {
		return 1
	}
	if !result.OK {
		return 3
	}
	return 0
}

func runDoctor(ctx context.Context) doctorResult {
	var checks []doctorCheck
	home, err := dataHome()
	if err != nil {
		checks = append(checks, doctorCheck{Name: "data", Status: "fail", Code: errorcode.ConnectionFailed})
		return summarizeDoctor(checks)
	}
	checks = append(checks, dataCheck(home))
	client, daemon := daemonCheck(ctx, home)
	checks = append([]doctorCheck{daemon}, checks...)
	if client == nil {
		for _, name := range []string{"model", "sandbox"} {
			checks = append(checks, doctorCheck{Name: name, Status: "skip"})
		}
		checks = append(checks, gitCheck(), doctorCheck{Name: "mcp", Status: "skip"})
		return summarizeDoctor(checks)
	}
	defer client.Close()
	checks = append(checks, modelCheck(ctx, client), sandboxCheck(ctx, client), gitCheck(), mcpCheckOf(ctx, client))
	return summarizeDoctor(checks)
}

func summarizeDoctor(checks []doctorCheck) doctorResult {
	result := doctorResult{OK: true, Checks: checks}
	for _, check := range checks {
		if check.Status == "fail" {
			result.OK = false
		}
	}
	return result
}

// daemonCheck connects to the engine, starting it when it does not run.
func daemonCheck(ctx context.Context, home string) (*protocol.Client, doctorCheck) {
	_, readErr := server.ReadInfo(home)
	client, err := ensureEngine(ctx, home, "", "")
	if err != nil {
		return nil, doctorCheck{Name: "daemon", Status: "fail", Code: errorcode.ConnectionFailed}
	}
	var status protocol.EngineStatus
	if err := client.Call(ctx, "engine.status", struct{}{}, &status); err != nil {
		_ = client.Close()
		return nil, doctorCheck{Name: "daemon", Status: "fail", Code: errorcode.ConnectionFailed}
	}
	detail := fmt.Sprintf("pid %d", status.PID)
	if info, err := server.ReadInfo(home); err == nil {
		if parsed, err := url.Parse(info.Endpoint); err == nil && parsed.Port() != "" {
			detail += ", port " + parsed.Port()
		}
	}
	if readErr != nil {
		detail += ", started"
	}
	return client, doctorCheck{Name: "daemon", Status: "ok", Detail: detail}
}

// dataCheck tries to write in the data folder.
func dataCheck(home string) doctorCheck {
	file, err := os.CreateTemp(home, ".doctor-*")
	if err != nil {
		return doctorCheck{Name: "data", Status: "fail", Detail: home, Code: errorcode.StorageRequestFailed}
	}
	name := file.Name()
	_ = file.Close()
	_ = os.Remove(name)
	return doctorCheck{Name: "data", Status: "ok", Detail: home}
}

// modelCheck runs one short turn of a new conversation on the default model and removes the conversation again.
func modelCheck(ctx context.Context, client *protocol.Client) doctorCheck {
	check := doctorCheck{Name: "model", Status: "fail", Code: errorcode.ModelRequestFailed}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Workdir: os.TempDir()}, &created); err != nil {
		return check
	}
	defer func() {
		_ = client.Call(context.WithoutCancel(ctx), "session.delete", protocol.SessionCancelParams{Session: created.Session}, nil)
	}()
	var state struct {
		Config struct {
			Provider string `json:"provider"`
			Model    string `json:"model"`
		} `json:"config"`
	}
	if err := client.Call(ctx, "session.snapshot", protocol.SessionCancelParams{Session: created.Session}, &state); err != nil {
		return check
	}
	if state.Config.Provider == "" || state.Config.Model == "" {
		return check
	}
	check.Detail = state.Config.Provider + "/" + state.Config.Model
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}, Types: []event.Type{loop.TurnFinished}}, nil); err != nil {
		return check
	}
	send := protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: "Reply with the single word ok."}}}
	if err := client.Call(ctx, "session.send", send, nil); err != nil {
		return check
	}
	for {
		select {
		case fact, open := <-client.Events:
			if !open {
				return check
			}
			if fact.Type != loop.TurnFinished {
				continue
			}
			outcome, err := event.Decode[loop.Outcome](fact)
			if err != nil {
				return check
			}
			if outcome.Stop == loop.Answered {
				return doctorCheck{Name: "model", Status: "ok", Detail: check.Detail}
			}
			if outcome.Code != "" {
				check.Code = outcome.Code
			}
			return check
		case <-ctx.Done():
			return check
		}
	}
}

// sandboxCheck warns, and does not fail, when the sandbox is not available: members then ask for every action.
func sandboxCheck(ctx context.Context, client *protocol.Client) doctorCheck {
	workdir, err := os.Getwd()
	if err != nil {
		workdir = ""
	}
	var status sandboxStatus
	if err := client.Call(ctx, "sandbox.status", protocol.SandboxStatusParams{Workdir: workdir}, &status); err != nil {
		return doctorCheck{Name: "sandbox", Status: "fail", Code: errorcode.ConnectionFailed}
	}
	if status.Available {
		return doctorCheck{Name: "sandbox", Status: "ok", Detail: status.Backend}
	}
	if status.Disabled {
		return doctorCheck{Name: "sandbox", Status: "warn", Detail: "off"}
	}
	return doctorCheck{Name: "sandbox", Status: "warn", Detail: status.Backend, Code: status.Reason}
}

// gitCheck warns when git cannot be run: worktrees, diffs and commits need it.
func gitCheck() doctorCheck {
	path, err := exec.LookPath("git")
	if err != nil {
		return doctorCheck{Name: "git", Status: "warn"}
	}
	version, err := exec.Command(path, "--version").Output()
	if err != nil {
		return doctorCheck{Name: "git", Status: "warn", Detail: path}
	}
	return doctorCheck{Name: "git", Status: "ok", Detail: strings.TrimSpace(string(version))}
}

func mcpCheckOf(ctx context.Context, client *protocol.Client) doctorCheck {
	directory, _ := os.Getwd()
	var statuses []mcpState
	if err := client.Call(ctx, "mcp.status", protocol.MCPStatusParams{Directory: directory}, &statuses); err != nil {
		return doctorCheck{Name: "mcp", Status: "fail", Code: errorcode.ConnectionFailed}
	}
	return mcpCheck(statuses)
}

// mcpCheck fails when a server failed to start, warns when one waits for a sign-in, and passes otherwise.
func mcpCheck(statuses []mcpState) doctorCheck {
	check := doctorCheck{Name: "mcp", Status: "ok"}
	var connected, failed, signIn []string
	for _, state := range statuses {
		switch state.Status {
		case "connected":
			connected = append(connected, state.Name)
		case "failed":
			failed = append(failed, state.Name)
			if check.Code == "" {
				check.Code = state.Code
			}
		case "needs_auth":
			signIn = append(signIn, state.Name)
		}
	}
	switch {
	case len(failed) > 0:
		check.Status, check.Detail = "fail", strings.Join(failed, ", ")
		if check.Code == "" {
			check.Code = errorcode.McpStartFailed
		}
	case len(signIn) > 0:
		check.Status, check.Detail = "warn", strings.Join(signIn, ", ")
	default:
		check.Detail = strings.Join(connected, ", ")
	}
	return check
}

func writeDoctor(output io.Writer, ui *renderer, result doctorResult) error {
	problems := 0
	for _, check := range result.Checks {
		if check.Status == "fail" {
			problems++
		}
		line := fmt.Sprintf("[%s] %s", ui.text("doctorStatus."+check.Status), ui.text("doctorItem."+check.Name))
		if check.Detail != "" {
			line += ": " + check.Detail
		}
		if check.Code != "" {
			line += " " + check.Code
			if spec, found := errorcode.Lookup(check.Code); found && check.Status != "ok" {
				line += " " + spec.Title.In(ui.language)
			}
		}
		if _, err := fmt.Fprintln(output, line); err != nil {
			return err
		}
	}
	if problems == 0 {
		_, err := fmt.Fprint(output, ui.text("doctorOK"))
		return err
	}
	_, err := fmt.Fprintf(output, ui.text("doctorFailed"), problems)
	return err
}
