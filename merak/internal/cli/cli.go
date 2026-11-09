// Package cli runs one merak command line.
package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
)

// Run executes one command and returns its process exit code.
func Run(args []string, stdin io.Reader, stdout io.Writer) (code int) {
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
	if len(args) == 1 && args[0] == "stop" {
		return stopEngine()
	}
	if len(args) >= 2 && args[0] == "event" && args[1] == "emit" {
		return emitEvent(args[2:], stdout)
	}
	if len(args) > 0 && args[0] == "diagnose" {
		return diagnoseCommand(args[1:], stdout, ui)
	}
	if len(args) > 0 && args[0] == "serve" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return serve(ctx, args[1:])
	}
	if len(args) > 0 && args[0] == "models" {
		return models(args[1:], stdout)
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
		parseErr := flags.Parse(args[1:])
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
		_, ok := openai.Builtin(*provider)
		if !ok && (*provider == "anthropic" || strings.HasSuffix(*provider, "-anthropic")) {
			_, ok = anthropic.Builtin(strings.TrimSuffix(*provider, "-anthropic"))
		}
		if !ok {
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
	return chat(input, fake.New(nil, replies...), "", "", stdin, stdout, ui)
}

func chat(input string, provider model.Provider, modelID string, thinking model.Thinking, stdin io.Reader, stdout io.Writer, ui *renderer) int {
	home := os.Getenv("MERAKCODE_HOME")
	if home == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return 1
		}
		home = filepath.Join(userHome, ".merakcode")
	}
	level := slog.LevelInfo
	if os.Getenv("MERAKCODE_LOG") == "debug" {
		level = slog.LevelDebug
	}
	logger, closeLog, err := platformlog.New(platformlog.Options{
		Dir: filepath.Join(home, "logs", "production", "cli"), Level: level, Component: "cli",
	})
	if err != nil {
		return 1
	}
	defer closeLog()
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	replies := make(chan permission.Reply)
	e, err := engine.New(engine.Deps{
		Providers: map[string]model.Provider{provider.Name(): provider}, Model: modelID, Thinking: thinking, Workdir: workdir,
		Ask: func(ctx context.Context, _ permission.Request) (permission.Reply, error) {
			select {
			case reply := <-replies:
				return reply, nil
			case <-ctx.Done():
				return permission.Reply{}, ctx.Err()
			}
		},
	})
	if err != nil {
		return 1
	}
	events, unsubscribe := e.Bus.Subscribe(event.Filter{})
	defer unsubscribe()
	finished := make(chan error, 1)
	go func() {
		outcome, err := e.Chat(ctx, provider.Name(), input)
		if err != nil {
			logger.Error("chat failed")
		} else {
			logger.Info("chat finished", "stop", outcome.Stop)
		}
		finished <- err
		unsubscribe()
	}()
	ask := terminalApproval(stdin, stdout, ui)
	var renderErr error
	printed := false
	reasoning := false
	for fact := range events {
		if renderErr != nil {
			continue
		}
		switch fact.Type {
		case session.MessageDelta:
			var chunk model.Chunk
			chunk, renderErr = event.Decode[model.Chunk](fact)
			if renderErr == nil && chunk.Kind == model.ReasoningChunk && chunk.Reasoning != nil {
				if !reasoning {
					_, renderErr = io.WriteString(stdout, ui.text("thinking"))
					reasoning = true
				}
				if renderErr == nil {
					_, renderErr = io.WriteString(stdout, chunk.Reasoning.Text)
					printed = true
				}
			}
			if renderErr == nil && chunk.Kind == model.Text && chunk.Text != "" {
				if reasoning {
					_, renderErr = fmt.Fprintln(stdout)
					reasoning = false
				}
				if renderErr != nil {
					break
				}
				_, renderErr = io.WriteString(stdout, chunk.Text)
				printed = true
			}
		case session.MessageCompleted:
			if printed {
				_, renderErr = fmt.Fprintln(stdout)
				printed = false
			}
			reasoning = false
			if renderErr == nil {
				var completed session.Completion
				completed, renderErr = event.Decode[session.Completion](fact)
				if renderErr == nil {
					renderErr = printCost(stdout, completed.Usage, ui)
				}
			}
		case permission.Requested:
			var request permission.Request
			request, renderErr = event.Decode[permission.Request](fact)
			if renderErr == nil {
				var reply permission.Reply
				reply, renderErr = ask(ctx, request)
				if renderErr == nil {
					select {
					case replies <- reply:
					case <-ctx.Done():
						renderErr = ctx.Err()
					}
				}
			}
		}
		if renderErr != nil {
			cancel()
		}
	}
	if err := <-finished; err != nil || renderErr != nil {
		return 1
	}
	return 0
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

func terminalApproval(stdin io.Reader, stdout io.Writer, ui *renderer) func(context.Context, permission.Request) (permission.Reply, error) {
	scanner := bufio.NewScanner(stdin)
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
