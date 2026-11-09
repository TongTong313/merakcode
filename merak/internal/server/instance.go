package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/question"
	"github.com/TongTong313/merakcode/merak/internal/platform/config"
	platformlog "github.com/TongTong313/merakcode/merak/internal/platform/log"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type Instance struct {
	Info   protocol.ConnectionInfo
	http   *http.Server
	server *Server
	lock   *os.File
	home   string
	once   sync.Once
}

func (i *Instance) Ask(ctx context.Context, request permission.Request) (permission.Reply, error) {
	return i.server.Ask(ctx, request)
}

func (i *Instance) AskQuestion(ctx context.Context, request question.Request) (question.Answer, error) {
	return i.server.AskQuestion(ctx, request)
}

func Start(e *engine.Engine, home string, storage ...*RemoteStore) (*Instance, error) {
	return StartOn(e, home, 0, storage...)
}

func StartOn(e *engine.Engine, home string, port int, storage ...*RemoteStore) (*Instance, error) {
	dir := home
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := secureDirectory(dir); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(dir, "engine.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(lock); err != nil {
		lock.Close()
		return nil, err
	}
	settings, err := config.Open(filepath.Join(home, "merakcode.json"))
	if err != nil {
		lock.Close()
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil && port > 0 && port <= 65535 {
		listener, err = net.Listen("tcp4", "127.0.0.1:0")
	}
	if err != nil {
		lock.Close()
		return nil, err
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		listener.Close()
		lock.Close()
		return nil, err
	}
	info := protocol.ConnectionInfo{Endpoint: "ws://" + listener.Addr().String() + "/rpc", Token: hex.EncodeToString(secret[:]), PID: os.Getpid(), Protocol: protocol.Version}
	handler := New(e, info.Token)
	handler.settings = settings
	e.ConfigureNetworkSettings(settings)
	handler.applyConfiguration(settings.Private())
	handler.dataDir = home
	handler.logRoot, _ = platformlog.Root()
	if len(storage) > 0 {
		handler.Storage = storage[0]
	}
	instance := &Instance{Info: info, http: &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}, server: handler, lock: lock, home: home}
	body, err := json.Marshal(info)
	if err == nil {
		err = writeInfo(dir, body)
	}
	if err != nil {
		listener.Close()
		lock.Close()
		return nil, err
	}
	go func() { _ = instance.http.Serve(listener) }()
	return instance, nil
}

func ReadInfo(home string) (protocol.ConnectionInfo, error) {
	var info protocol.ConnectionInfo
	body, err := os.ReadFile(filepath.Join(home, "engine.json"))
	if err != nil {
		return info, err
	}
	err = json.Unmarshal(body, &info)
	return info, err
}

func writeInfo(dir string, body []byte) error {
	file, err := os.CreateTemp(dir, ".engine-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(body); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(dir, "engine.json"))
}

func (i *Instance) Close() error {
	i.once.Do(func() {
		i.server.Close()
		i.http.Close()
		if current, err := ReadInfo(i.home); err == nil && current.Token == i.Info.Token {
			os.Remove(filepath.Join(i.home, "engine.json"))
		}
		i.lock.Close()
	})
	return nil
}

func (i *Instance) Done() <-chan struct{} { return i.server.Done() }

func (i *Instance) SetLogLevel(level *slog.LevelVar) {
	i.server.configMu.Lock()
	defer i.server.configMu.Unlock()
	i.server.Level = level
	if value := i.server.settings.Private().Log; value != "" {
		var parsed slog.Level
		if parsed.UnmarshalText([]byte(value)) == nil {
			level.Set(parsed)
		}
	}
}
