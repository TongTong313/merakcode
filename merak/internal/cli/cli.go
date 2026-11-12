// Package cli runs one merak command line.
package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"os"
	"os/signal"

	"strings"
	"syscall"

	"github.com/TongTong313/merakcode/merak"

	"github.com/TongTong313/merakcode/merak/engine/model"

	"github.com/TongTong313/merakcode/merak/engine/model/fake"

	"github.com/TongTong313/merakcode/merak/engine/permission"

	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// Run executes one command and returns its process exit code.
func Run(args []string, stdin io.Reader, stdout io.Writer) (code int) {
	if len(args) == 1 && args[0] == "internal-read-tool" {
		return readCode(stdin, stdout)
	}
	if len(args) > 0 && args[0] == "mcp" {
		return runMCP(args[1:], stdin, stdout)
	}
	if len(args) > 0 && args[0] == "acp" {
		return runACP(args[1:], stdin, stdout)
	}
	ui := &renderer{language: defaultLanguage()}
	defer func() {
		if code == 2 {
			ui.failure(stdout, errorcode.InvalidArguments)
		}
		if code == 1 {
			ui.failure(stdout, errorcode.ConnectionFailed)
		}
	}()
	if len(args) > 0 && (args[0] == "--lang" || strings.HasPrefix(args[0], "--lang=")) {
		selected := strings.TrimPrefix(args[0], "--lang=")
		if args[0] == "--lang" {
			if len(args) < 2 {
				return 2
			}
			selected, args = args[1], args[1:]
		}
		if selected != "zh" && selected != "en" {
			return 2
		}
		ui.language, args = selected, args[1:]
	}
	if len(args) == 1 && args[0] == "status" {
		return statusCommand(stdout, ui)
	}
	if len(args) == 1 && args[0] == "stop" {
		return stopEngine()
	}
	if len(args) >= 2 && args[0] == "event" && args[1] == "emit" {
		return emitEvent(args[2:], stdout)
	}
	if len(args) > 0 && args[0] == "diagnose" {
		return diagnoseCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "service" {
		return serviceCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "doctor" {
		return doctorCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "sandbox" {
		return sandboxCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "bug-report" {
		return bugReportCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "logs" {
		return logsCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "upgrade" {
		return upgradeCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "stats" {
		return statsCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "generate" {
		return generateCommand(args[1:], stdout)
	}
	if len(args) > 0 && args[0] == "serve" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return serve(ctx, args[1:])
	}
	if len(args) > 0 && args[0] == "provider" {
		return providerCommand(args[1:], stdin, stdout)
	}
	if len(args) > 0 && args[0] == "models" {
		return models(args[1:], stdout)
	}
	if len(args) > 0 && args[0] == "cloud" {
		return cloudCommand(args[1:], stdout)
	}
	if len(args) > 0 && args[0] == "skill" {
		return skillCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "schedule" {
		return scheduleCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "command" {
		return commandCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "session" {
		return sessionCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "export" {
		return exportCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "import" {
		return importCommand(args[1:], stdin, stdout, ui)
	}
	if len(args) > 0 && args[0] == "agent" {
		return agentCommand(args[1:], stdin, stdout, ui)
	}
	if len(args) > 0 && (args[0] == "group" || args[0] == "task") {
		return groupCommand(args, stdin, stdout, ui)
	}
	if len(args) == 1 && args[0] == "--version" {
		fmt.Fprintln(stdout, merak.Version())
		return 0
	}
	if len(args) == 5 && args[0] == "debug" && args[1] == "chat" && args[2] == "--script" {
		return debugChat(args[3], args[4], stdin, stdout, ui)
	}
	if len(args) >= 2 && args[0] == "debug" && args[1] == "worker" {
		return debugWorker(args[2:], stdin, stdout)
	}
	if len(args) > 0 && args[0] == "run" {
		flags := flag.NewFlagSet("run", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		provider := flags.String("provider", "openai", "")
		name := flags.String("model", os.Getenv("OPENAI_MODEL"), "")
		thinking := flags.String("thinking", "", "")
		base := flags.String("base-url", os.Getenv("OPENAI_BASE_URL"), "")
		lang := flags.String("lang", ui.language, "")
		machine := flags.Bool("json", false, "")
		parseErr := flags.Parse(args[1:])
		ui.machine = *machine
		if *lang != "zh" && *lang != "en" {
			return 2
		}
		ui.language = *lang
		if parseErr != nil || flags.NArg() != 1 || *name == "" {
			return 2
		}
		switch model.Thinking(*thinking) {
		case "", model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax:
		default:
			return 2
		}
		return runProtocol(flags.Arg(0), *provider, *name, model.Thinking(*thinking), *base, stdin, stdout, ui)
	}
	return 2
}

func debugChat(path, input string, stdin io.Reader, stdout io.Writer, ui *renderer) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 1
	}
	var replies []fake.Reply
	if err := json.Unmarshal(data, &replies); err != nil || len(replies) == 0 {
		return 2
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, closeHost, err := debugClient(ctx, fake.New(nil, replies...))
	if err != nil {
		return 1
	}
	defer closeHost()
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	return protocolChat(ctx, client, protocol.SessionCreateParams{Provider: "fake", Workdir: workdir}, input, stdin, stdout, ui)
}
func printCost(out io.Writer, usage model.Usage, ui *renderer) error {
	if usage.Input+usage.Output == 0 {
		return nil
	}
	if !usage.CostKnown {
		_, err := io.WriteString(out, ui.text("unknownCost"))
		return err
	}
	_, err := fmt.Fprintf(out, ui.text("estimatedCost"), usage.Currency, usage.Cost)
	return err
}

func terminalApproval(scanner *bufio.Scanner, stdout io.Writer, ui *renderer) func(context.Context, permission.Request) (permission.Reply, error) {
	return func(ctx context.Context, request permission.Request) (permission.Reply, error) {
		if err := ctx.Err(); err != nil {
			return permission.Reply{}, err
		}
		var input struct {
			Path    string `json:"path"`
			Command string `json:"command"`
		}
		if err := json.Unmarshal(request.Call.Input, &input); err != nil {
			return permission.Reply{Decision: permission.Deny}, nil
		}
		prompt := ui.text("allowWrite")
		target := input.Path
		if request.Spec.Effect == tool.EffectExec {
			target = input.Command
			prompt = ui.text("allowExec")
		}
		if _, err := fmt.Fprintf(stdout, prompt, target); err != nil {
			return permission.Reply{}, err
		}
		decision := permission.Deny
		if scanner.Scan() && strings.EqualFold(strings.TrimSpace(scanner.Text()), "y") {
			decision = permission.Allow
		}
		return permission.Reply{Decision: decision}, scanner.Err()
	}
}
