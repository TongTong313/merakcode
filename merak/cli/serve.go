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

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/anthropic"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/openai"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/question"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/protocol"
	"github.com/TongTong313/merakcode/merak/server"
	"github.com/TongTong313/merakcode/merak/storage/configfile"
	"github.com/TongTong313/merakcode/merak/storage/localstore"
	"github.com/TongTong313/merakcode/merak/storage/logfile"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/storage/vault"
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
	dirs, closeDirs, err := workingDirs(home)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	removeHome := cleanup
	cleanup = func() { closeDirs(); removeHome() }
	var instance *server.Instance
	providers := map[string]model.Provider{}
	if provider != nil {
		providers[provider.Name()] = provider
	}
	e, err := engine.New(engine.Deps{NewLink: func() wire.Link { return cloudlink.NewWebSocket() }, Dial: cloudlink.Dial, DataDir: home, Dirs: dirs, Vault: newVault(home), Store: memory.New(), Workdir: workdir, Providers: providers,
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
	settings, err := configfile.Open(root)
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
	logDir, err := logfile.Directory("engine", *development)
	if err != nil {
		return 1
	}
	var level slog.LevelVar
	if os.Getenv("MERAKCODE_LOG") == "debug" {
		level.Set(slog.LevelDebug)
	}
	logger, closeLog, err := logfile.New(logfile.Options{Dir: logDir, LevelVar: &level, Component: "engine"})
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
		if errors.Is(err, localstore.ErrFormatOutdated) {
			logger.Error("the data of an earlier format is not migrated", "code", err.Error())
		}
		return 1
	}
	defer local.Close()
	dirs, closeDirs, err := workingDirs(home)
	if err != nil {
		return 1
	}
	defer closeDirs()
	e, err := engine.New(engine.Deps{NewLink: func() wire.Link { return cloudlink.NewWebSocket() }, Dial: cloudlink.Dial, DataDir: home, Dirs: dirs, Vault: newVault(home), Logger: logger, Store: local, Providers: providers, Catalog: catalogue, Workdir: workdir, Ask: func(ctx context.Context, request permission.Request) (permission.Reply, error) {
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

// workingDirs preserves the existing paths; the caller removes temporary snapshots after engine shutdown.
func workingDirs(data string) (engine.Dirs, func(), error) {
	dirs := engine.Dirs{Temporary: os.TempDir()}
	if data != "" {
		dirs.Snapshots = filepath.Join(data, "snapshots")
		dirs.Worktrees = data
		dirs.SkillCache = filepath.Join(data, "..", "cache", "skills")
		dirs.SandboxState = filepath.Join(data, "sandbox")
		return dirs, func() {}, nil
	}
	snapshots, err := os.MkdirTemp("", "merak-snapshots-")
	if err != nil {
		return engine.Dirs{}, nil, err
	}
	dirs.Snapshots = snapshots
	dirs.Worktrees = filepath.Join(os.TempDir(), "merak-chat")
	dirs.SkillCache = filepath.Join(os.TempDir(), "merak-skills")
	dirs.SandboxState = os.TempDir()
	return dirs, func() { _ = os.RemoveAll(snapshots) }, nil
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

func newVault(dataDir string) credential.Vault {
	switch {
	case dataDir != "" && os.Getenv("MERAKCODE_FILE_CREDENTIALS") == "1":
		// For machines without a system vault, and for tests: private files under the data directory.
		return vault.NewFile(filepath.Join(dataDir, "credentials"))
	case dataDir != "":
		return vault.New(filepath.Join(dataDir, "credentials"))
	}
	return vault.NewMemory()
}
