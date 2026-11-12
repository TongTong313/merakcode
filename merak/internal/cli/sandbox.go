package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type sandboxStatus = sandbox.Status

// sandboxCommand runs merak sandbox status, setup and reset.
func sandboxCommand(args []string, output io.Writer, ui *renderer) int {
	if len(args) == 0 {
		return 2
	}
	switch args[0] {
	case "status":
		return sandboxStatusCommand(args[1:], output, ui)
	case "setup":
		if len(args) != 1 {
			return 2
		}
		return sandboxSetupCommand(output, ui)
	case "reset":
		if len(args) != 1 {
			return 2
		}
		return sandboxResetCommand(output, ui)
	}
	return 2
}

func sandboxStatusCommand(args []string, output io.Writer, ui *renderer) int {
	flags := flag.NewFlagSet("sandbox status", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	machine := flags.Bool("json", false, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	var status sandboxStatus
	code := callEngine(io.Discard, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		err := client.Call(ctx, "sandbox.status", protocol.SandboxStatusParams{Workdir: workdir}, &status)
		return status, err
	})
	if code != 0 {
		return code
	}
	if *machine {
		if json.NewEncoder(output).Encode(status) != nil {
			return 1
		}
		return 0
	}
	if writeSandboxStatus(output, ui, status) != nil {
		return 1
	}
	return 0
}

// writeSandboxStatus says in one line whether the sandbox works, then what the system cannot enforce.
func writeSandboxStatus(output io.Writer, ui *renderer, status sandboxStatus) error {
	var headline string
	switch {
	case status.Disabled:
		headline = ui.text("sandboxOff")
	case status.Available:
		headline = fmt.Sprintf(ui.text("sandboxOn"), status.Backend)
	case status.WaitingAccount:
		headline = ui.text("sandboxWaiting")
	case status.Backend == "windows-account":
		headline = ui.text("sandboxNotSetUp") + "\n" + ui.text("sandboxSetupHint")
	default:
		headline = ui.text("sandboxUnavailable")
		if status.Reason != "" {
			headline += " " + status.Reason
		}
	}
	if _, err := fmt.Fprintln(output, headline); err != nil {
		return err
	}
	if status.Available && status.Reason != "" {
		if _, err := fmt.Fprintf(output, ui.text("sandboxReason")+"\n", status.Reason); err != nil {
			return err
		}
	}
	if len(status.Limits) == 0 {
		return nil
	}
	if _, err := fmt.Fprintln(output, ui.text("sandboxLimits")); err != nil {
		return err
	}
	for _, limit := range status.Limits {
		text := ui.text("sandboxLimit." + limit)
		if text == "" {
			text = limit
		}
		if _, err := fmt.Fprintf(output, "  - %s\n", text); err != nil {
			return err
		}
	}
	return nil
}

func sandboxSetupCommand(output io.Writer, ui *renderer) int {
	if _, err := fmt.Fprint(output, ui.text("sandboxSettingUp")); err != nil {
		return 1
	}
	code := callEngine(output, ui, func(ctx context.Context, client *protocol.Client) (any, error) {
		return nil, client.Call(ctx, "sandbox.setup", struct{}{}, nil)
	})
	if code != 0 {
		return code
	}
	if _, err := fmt.Fprint(output, ui.text("sandboxSetUp")); err != nil {
		return 1
	}
	return 0
}

// sandboxResetCommand undoes the Windows setup. It works on the files of this machine and not through the engine:
// the engine keeps the accounts in use, so it has to be stopped first, and with the engine stopped nothing can
// start a member behind the reset's back.
func sandboxResetCommand(output io.Writer, ui *renderer) int {
	home, err := dataHome()
	if err != nil {
		return 1
	}
	directory := filepath.Join(home, "sandbox")
	if !sandbox.Initialized(directory) {
		if _, err := fmt.Fprint(output, ui.text("sandboxNothingToReset")); err != nil {
			return 1
		}
		return 0
	}
	if engineRunning() {
		ui.failure(output, errorcode.SandboxResetFailed)
		fmt.Fprint(output, ui.text("sandboxStopFirst"))
		return 1
	}
	if _, err := fmt.Fprint(output, ui.text("sandboxResetting")); err != nil {
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := sandbox.Reset(ctx, directory); err != nil {
		ui.failure(output, errorcode.SandboxResetFailed)
		return 1
	}
	if _, err := fmt.Fprint(output, ui.text("sandboxWasReset")); err != nil {
		return 1
	}
	return 0
}
