package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/internal/server"
	"github.com/TongTong313/merakcode/merak/protocol"
)

// debugClient hosts an isolated engine; debug commands use its public protocol.
func debugClient(ctx context.Context, provider model.Provider) (*protocol.Client, func(), error) {
	home, err := os.MkdirTemp("", "merak-debug-*")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(home) }
	workdir, err := os.Getwd()
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	var instance *server.Instance
	providers := map[string]model.Provider{}
	if provider != nil {
		providers[provider.Name()] = provider
	}
	e, err := engine.New(engine.Deps{DataDir: home, Workdir: workdir, Providers: providers,
		Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
			return instance.Ask(ctx, request)
		},
		AskQuestion: func(ctx context.Context, request question.Request) (question.Answer, error) {
			return instance.AskQuestion(ctx, request)
		},
	})
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	instance, err = server.Start(e, home)
	if err != nil {
		_ = e.Close()
		cleanup()
		return nil, nil, err
	}
	client, err := connectEngine(ctx, home)
	if err != nil {
		_ = instance.Close()
		cleanup()
		return nil, nil, err
	}
	return client, func() { _ = client.Close(); _ = instance.Close(); cleanup() }, nil
}

func serve(ctx context.Context, args []string) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	script := flags.String("script", "", "")
	overrides := flags.String("model-overrides", "", "")
	development := flags.Bool("development", false, "")
	port := flags.Int("port", 0, "")
	listen := flags.String("listen", "127.0.0.1", "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	root, err := configRoot()
	if err != nil {
		return 1
	}
	settings, err := config.Open(root)
	if err != nil {
		return 1
	}
	given := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { given[f.Name] = true })
	configured := settings.Get().Server
	if !given["port"] && configured.Port != 0 {
		*port = configured.Port
	}
	if !given["listen"] && configured.Hostname != "" {
		*listen = configured.Hostname
	}
	if *port < 0 || *port > 65535 || net.ParseIP(*listen) == nil {
		return 2
	}
	logDir, err := platformlog.Directory("engine", *development)
	if err != nil {
		return 1
	}
	var level slog.LevelVar
	if os.Getenv("MERAKCODE_LOG") == "debug" {
		level.Set(slog.LevelDebug)
	}
	logger, closeLog, err := platformlog.New(platformlog.Options{Dir: logDir, LevelVar: &level, Component: "engine"})
	if err != nil {
		return 1
	}
	defer closeLog()
	logger.Info("engine starting")
	home, err := dataHome()
	if err != nil {
		return 1
	}
	workdir, err := os.Getwd()
	if err != nil {
		return 1
	}
	providers := map[string]model.Provider{}
	if *script != "" {
		body, err := os.ReadFile(*script)
		if err != nil {
			return 1
		}
		var replies []fake.Reply
		if json.Unmarshal(body, &replies) != nil || len(replies) == 0 {
			return 2
		}
		providers["fake"] = fake.New(nil, replies...)
	}
	catalogue, err := configuredCatalog(*overrides)
	if err != nil {
		return 1
	}
	for _, name := range []string{"openai", "deepseek", "moonshot", "zhipu", "dashscope", "gemini", "openrouter"} {
		config, _ := openai.Builtin(name)
		prefix := strings.ToUpper(name)
		providers[name] = openai.New(openai.Options{Config: config, BaseURL: os.Getenv(prefix + "_BASE_URL"), APIKey: os.Getenv(prefix + "_API_KEY"), Catalog: catalogue})
	}
	for _, name := range []string{"anthropic", "deepseek", "moonshot", "zhipu"} {
		config, _ := anthropic.Builtin(name)
		id := name
		if name != "anthropic" {
			id += "-anthropic"
		}
		providers[id] = anthropic.New(anthropic.Options{Config: config, BaseURL: os.Getenv(strings.ToUpper(id) + "_BASE_URL"), APIKey: os.Getenv(strings.ToUpper(name) + "_API_KEY"), Catalog: catalogue})
	}
	ready := make(chan struct{})
	var instance *server.Instance
	if err := os.MkdirAll(home, 0700); err != nil {
		return 1
	}
	local, err := localstore.Open(filepath.Join(home, "merak.db"))
	if err != nil {
		return 1
	}
	defer local.Close()
	e, err := engine.New(engine.Deps{DataDir: home, Logger: logger, Store: local, Providers: providers, Catalog: catalogue, Workdir: workdir, Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
		select {
		case <-ready:
			return instance.Ask(ctx, request)
		case <-ctx.Done():
			return permission.Reply{}, ctx.Err()
		}
	}, AskQuestion: func(ctx context.Context, request question.Request) (question.Answer, error) {
		select {
		case <-ready:
			return instance.AskQuestion(ctx, request)
		case <-ctx.Done():
			return question.Answer{}, ctx.Err()
		}
	}})
	if err != nil {
		return 1
	}
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		return 1
	}
	instance, err = server.StartWith(e, server.Options{Data: home, Config: root, Address: *listen, Port: *port})
	if err != nil {
		return 1
	}
	instance.SetLogLevel(&level)
	close(ready)
	defer instance.Close()
	select {
	case <-ctx.Done():
	case <-instance.Done():
	}
	logger.Info("engine stopping")
	return 0
}

// configRoot is the one directory every file of the program lives under: MERAKCODE_HOME, or ~/.merakcode.
func configRoot() (string, error) {
	if root := os.Getenv("MERAKCODE_HOME"); root != "" {
		return root, nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userHome, ".merakcode"), nil
}

// dataHome holds the conversation database and the connection file of the engine.
func dataHome() (string, error) {
	root, err := configRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "data"), nil
}

func configuredCatalog(path string) (*catalog.Catalog, error) {
	var options catalog.Options
	for _, provider := range []string{"anthropic", "openrouter"} {
		prefix := strings.ToUpper(provider)
		key, base := os.Getenv(prefix+"_API_KEY"), os.Getenv(prefix+"_BASE_URL")
		if key != "" || base != "" {
			options.Sources = append(options.Sources, catalog.Source{Provider: provider, APIKey: key, BaseURL: base})
		}
	}
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options.Overrides); err != nil {
			return nil, err
		}
		if decoder.Decode(new(any)) != io.EOF {
			return nil, errors.New("expected one overrides array")
		}
		for _, override := range options.Overrides {
			if override.Provider == "" || override.ID == "" || override.Window != nil && *override.Window <= 0 || override.MaxOutput != nil && *override.MaxOutput <= 0 {
				return nil, errors.New("invalid model override")
			}
		}
	}
	return catalog.New(options), nil
}
