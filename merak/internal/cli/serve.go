package cli

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/internal/localstore"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/internal/server"
)

func serve(ctx context.Context, args []string) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	script := flags.String("script", "", "")
	storageMode := flags.String("store", "local", "")
	overrides := flags.String("model-overrides", "", "")
	refresh := flags.Bool("refresh-models", false, "")
	development := flags.Bool("development", false, "")
	port := flags.Int("port", 0, "")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	if (*storageMode != "local" && *storageMode != "remote") || *port < 0 || *port > 65535 {
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
	if *refresh {
		if err := catalogue.Refresh(ctx); err != nil {
			return 1
		}
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
	var storage store.Store
	var remote *server.RemoteStore
	if *storageMode == "remote" {
		remote = server.NewRemoteStore()
		storage = store.NewBuffered(remote, 4096)
	} else {
		if err := os.MkdirAll(home, 0700); err != nil {
			return 1
		}
		local, err := localstore.Open(filepath.Join(home, "merak.db"))
		if err != nil {
			return 1
		}
		defer local.Close()
		storage = local
	}
	e, err := engine.New(engine.Deps{DataDir: home, Logger: logger, Store: storage, Providers: providers, Catalog: catalogue, Workdir: workdir, Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
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
	if remote == nil {
		if err := e.Recover(ctx); err != nil {
			return 1
		}
	}
	instance, err = server.StartOn(e, home, *port, remote)
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

func dataHome() (string, error) {
	if home := os.Getenv("MERAKCODE_HOME"); home != "" {
		return home, nil
	}
	if runtime.GOOS == "windows" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(dir, "MerakCode"), nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(userHome, "Library", "Application Support", "MerakCode"), nil
	}
	if dir := os.Getenv("XDG_DATA_HOME"); filepath.IsAbs(dir) {
		return filepath.Join(dir, "merakcode"), nil
	}
	return filepath.Join(userHome, ".local", "share", "merakcode"), nil
}
