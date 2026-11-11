package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
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

func Start(e *engine.Engine, home string) (*Instance, error) {
	return StartOn(e, home, 0)
}

func StartOn(e *engine.Engine, home string, port int) (*Instance, error) {
	return StartListening(e, home, "127.0.0.1", port)
}

// StartListening exposes the authenticated protocol at an explicitly selected address. The configuration file is read
// from the same directory as the connection file.
func StartListening(e *engine.Engine, home, address string, port int) (*Instance, error) {
	return StartWith(e, Options{Data: home, Config: home, Address: address, Port: port})
}

// Options says where the engine keeps its files and where it listens.
type Options struct {
	// Data holds engine.json and the lock file.
	Data string
	// Config is the root directory of the global configuration file.
	Config  string
	Address string
	Port    int
}

// StartWith exposes the authenticated protocol as the options say.
func StartWith(e *engine.Engine, options Options) (*Instance, error) {
	home, address, port := options.Data, options.Address, options.Port
	ip := net.ParseIP(address)
	if ip == nil || port < 0 || port > 65535 {
		return nil, errors.New("MRK-3001")
	}
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
	settings, err := config.Open(options.Config)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err := migrateSecrets(context.Background(), settings, e.Vault(), home); err != nil {
		lock.Close()
		return nil, err
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(address, strconv.Itoa(port)))
	if err != nil && port > 0 && ip.IsLoopback() {
		listener, err = net.Listen("tcp", net.JoinHostPort(address, "0"))
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
	endpoint := listener.Addr().String()
	if ip.IsUnspecified() {
		local := "::1"
		if ip.To4() != nil {
			local = "127.0.0.1"
		}
		endpoint = net.JoinHostPort(local, strconv.Itoa(listener.Addr().(*net.TCPAddr).Port))
	}
	info := protocol.ConnectionInfo{Endpoint: "ws://" + endpoint + "/rpc", Token: hex.EncodeToString(secret[:]), PID: os.Getpid(), Protocol: protocol.Version}
	handler := New(e, info.Token)
	handler.settings = settings
	e.ConfigureNetworkSettings(settings)
	handler.dataDir, handler.configRoot = home, options.Config
	handler.applyConfiguration(settings.Private())
	handler.logRoot, _ = platformlog.Root()
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
	handler.restoreCloud()
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

// AddIdentity makes a token for connections that act as another person than the one of this machine.
func (i *Instance) AddIdentity(human event.ID) string { return i.server.AddIdentity(human) }
