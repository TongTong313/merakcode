package cli

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func runProtocol(input, provider, modelID string, thinking model.Thinking, base string, stdin io.Reader, stdout io.Writer, ui *renderer) (code int) {
	home, err := dataHome()
	if err != nil {
		return 1
	}
	level := slog.LevelInfo
	if os.Getenv("MERAKCODE_LOG") == "debug" {
		level = slog.LevelDebug
	}
	logDir, err := platformlog.Directory("cli", false)
	if err != nil {
		return 1
	}
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: logDir, Level: level, Component: "cli"})
	if err != nil {
		return 1
	}
	defer closeLog()
	defer func() {
		if code == 0 {
			logger.Info("chat finished")
		} else {
			logger.Error("chat failed")
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, err := connectEngine(ctx, home)
	if err != nil {
		if err = startEngine(provider, base); err != nil {
			return 1
		}
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
	wait:
		for {
			select {
			case <-deadline.C:
				return 1
			case <-ticker.C:
				client, err = connectEngine(ctx, home)
				if err == nil {
					break wait
				}
			}
		}
	}
	defer client.Close()
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	var created protocol.SessionCreateResult
	if err := client.Call(ctx, "session.create", protocol.SessionCreateParams{Provider: provider, Model: modelID, Thinking: thinking, Workdir: workdir}, &created); err != nil {
		return 1
	}
	if err := client.Call(ctx, "events.subscribe", event.Filter{Scope: event.Scope{Session: created.Session}}, nil); err != nil {
		return 1
	}
	if err := client.Call(ctx, "session.send", protocol.SessionSendParams{Session: created.Session, Parts: []model.Part{{Text: input}}}, nil); err != nil {
		return 1
	}
	printed, reasoning := false, false
	ask := terminalApproval(stdin, stdout, ui)
	for fact := range client.Events {
		switch fact.Type {
		case permission.Requested:
			request, err := event.Decode[permission.Request](fact)
			if err != nil {
				return 1
			}
			reply, err := ask(ctx, request)
			if err != nil {
				return 1
			}
			if err := client.Call(ctx, "permission.reply", protocol.PermissionReplyParams{Request: fact.ID, Decision: reply.Decision}, nil); err != nil {
				return 1
			}
		case session.MessageDelta:
			chunk, err := event.Decode[model.Chunk](fact)
			if err != nil {
				return 1
			}
			if chunk.Kind == model.ReasoningChunk && chunk.Reasoning != nil {
				if !reasoning {
					if _, err := io.WriteString(stdout, ui.text("thinking")); err != nil {
						return 1
					}
					reasoning = true
				}
				if _, err := io.WriteString(stdout, chunk.Reasoning.Text); err != nil {
					return 1
				}
				printed = true
			}
			if chunk.Kind == model.Text && chunk.Text != "" {
				if reasoning {
					if _, err := fmt.Fprintln(stdout); err != nil {
						return 1
					}
					reasoning = false
				}
				if _, err := io.WriteString(stdout, chunk.Text); err != nil {
					return 1
				}
				printed = true
			}
		case session.MessageCompleted:
			if printed {
				if _, err := fmt.Fprintln(stdout); err != nil {
					return 1
				}
				printed = false
			}
			reasoning = false
			completion, err := event.Decode[session.Completion](fact)
			if err != nil || printCost(stdout, completion.Usage, ui) != nil {
				return 1
			}
		case loop.TurnFinished:
			outcome, err := event.Decode[loop.Outcome](fact)
			if err != nil || outcome.Stop != loop.Answered {
				if outcome.Code != "" {
					ui.failure(stdout, outcome.Code)
				}
				return 1
			}
			return 0
		case event.Lagged:
			return 1
		}
	}
	return 1
}

func startEngine(provider, base string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(executable, "serve")
	command.Env = os.Environ()
	if base != "" {
		key := strings.ToUpper(provider) + "_BASE_URL"
		var environment []string
		for _, entry := range command.Env {
			name, _, _ := strings.Cut(entry, "=")
			if !strings.EqualFold(name, key) {
				environment = append(environment, entry)
			}
		}
		command.Env = append(environment, key+"="+base)
	}
	prepareBackground(command)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func connectEngine(ctx context.Context, home string) (*protocol.Client, error) {
	info, err := server.ReadInfo(home)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return protocol.Connect(dialCtx, info.Endpoint, info.Token, protocol.HelloParams{Protocol: protocol.Version, Client: protocol.ClientInfo{Name: "cli", Version: merak.Version()}, Capabilities: protocol.Capabilities{Approve: true}})
}
