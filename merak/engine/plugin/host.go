// Package plugin runs the plugins of v0.3.x: JavaScript files and npm packages that export a function returning
// hooks. Go cannot run JavaScript, so a small host script runs under Node, loads every plugin and talks to the
// engine with one JSON message per line on its standard input and output.
package plugin

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/internal/platform/sandbox"
)

//go:embed host.mjs
var hostScript []byte

// ErrNoNode is returned by Start when there is no Node.js to run the host with.
var ErrNoNode = errors.New("node.js is needed to run plugins")

// Spec names one plugin: a path of a .js or .mjs file, a file:// address, or the name of an npm package that
// plugin.add installed under the cache folder.
type Spec struct {
	Spec string `json:"spec"`
	// Options are the plugin's own options (the plugin_options entry); the engine does not interpret them.
	Options map[string]any `json:"options,omitempty"`
}

// Tool is a custom tool that a plugin declares.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}

// Status says what became of one plugin.
type Status struct {
	Spec string `json:"spec"`
	ID   string `json:"id"`
	// State is "loaded" or "failed"; Error says why in the second case.
	State string `json:"status"`
	Error string `json:"error,omitempty"`
	// Hooks are the hooks the engine will call; Ignored are hooks it does not support, such as experimental.* ones.
	Hooks   []string `json:"hooks"`
	Ignored []string `json:"ignored"`
	Tools   []Tool   `json:"tools"`
}

// Failure is one hook that threw or timed out. The turn goes on without it.
type Failure struct {
	Plugin string `json:"plugin"`
	Error  string `json:"error"`
}

// ToolContext says which conversation and call a plugin tool runs for.
type ToolContext struct {
	Session string `json:"session,omitempty"`
	Call    string `json:"call,omitempty"`
}

// Options say how the host starts.
type Options struct {
	// Launcher starts the host in the sandbox of the conversation, as it does MCP servers.
	Launcher *sandbox.Launcher
	Profile  sandbox.Profile
	// Directory is the workspace; Worktree is the root of its repository (the same when there is none).
	Directory, Worktree string
	// DataRoot holds one folder of persistent data for each plugin.
	DataRoot string
	// Cache is where the host script is written and the plugins installed from npm live; the default is under DataRoot.
	Cache string
	// ServerURL is handed to the plugins as serverUrl.
	ServerURL string
	// HookTimeout bounds each hook call; the default is 10 seconds.
	HookTimeout time.Duration
}

// Host is a running plugin host.
type Host struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	timeout time.Duration
	plugins int

	mu      sync.Mutex
	next    int
	pending map[int]chan reply
	dead    error
	done    chan struct{}
	once    sync.Once
}

type reply struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

func nodeCommand() (string, []string, error) {
	name, extra := "node", []string(nil)
	if configured := os.Getenv("MERAKCODE_NODE"); configured != "" {
		name, extra = configured, []string{"ELECTRON_RUN_AS_NODE=1"}
	}
	found, err := exec.LookPath(name)
	if err != nil {
		return "", nil, ErrNoNode
	}
	return found, extra, nil
}

// Start runs the host, loads the plugins and returns what became of each. A plugin that cannot load is reported as
// failed and the others still run.
func Start(ctx context.Context, options Options, specs []Spec) (*Host, []Status, error) {
	node, environment, err := nodeCommand()
	if err != nil {
		return nil, nil, err
	}
	if options.HookTimeout <= 0 {
		options.HookTimeout = 10 * time.Second
	}
	if options.Cache == "" {
		options.Cache = filepath.Join(options.DataRoot, ".host")
	}
	if options.ServerURL == "" {
		options.ServerURL = "http://127.0.0.1:0"
	}
	if err := os.MkdirAll(options.Cache, 0o700); err != nil {
		return nil, nil, err
	}
	script := filepath.Join(options.Cache, "host.mjs")
	if current, err := os.ReadFile(script); err != nil || string(current) != string(hostScript) {
		if err := os.WriteFile(script, hostScript, 0o600); err != nil {
			return nil, nil, err
		}
	}
	launcher := options.Launcher
	cmd, err := launcher.Command(ctx, options.Profile, node, script)
	if err != nil {
		return nil, nil, err
	}
	cmd.Dir = options.Directory
	cmd.Env = append(cmd.Environ(), environment...)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	hold := launcher.Hold()
	if err := launcher.Start(cmd, options.Profile); err != nil {
		hold()
		return nil, nil, err
	}
	h := &Host{cmd: cmd, stdin: stdin, timeout: options.HookTimeout, plugins: len(specs), pending: make(map[int]chan reply), done: make(chan struct{})}
	go func() {
		defer close(h.done)
		defer hold()
		_ = launcher.Wait(cmd)
		h.fail(errors.New("the plugin host exited"))
	}()
	go h.read(stdout)
	if specs == nil {
		specs = []Spec{}
	}
	params := map[string]any{
		"context": map[string]any{"directory": options.Directory, "worktree": options.Worktree, "dataRoot": options.DataRoot, "cache": filepath.Join(options.Cache, "plugins"), "serverUrl": options.ServerURL, "hookTimeout": options.HookTimeout.Milliseconds()},
		"plugins": specs,
	}
	loadCtx, cancel := context.WithTimeout(ctx, 30*time.Second+time.Duration(len(specs))*options.HookTimeout)
	defer cancel()
	var statuses []Status
	if err := h.request(loadCtx, "init", params, &statuses); err != nil {
		h.Close()
		return nil, nil, err
	}
	return h, statuses, nil
}

func (h *Host) read(output io.Reader) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for scanner.Scan() {
		var message reply
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		h.mu.Lock()
		waiting := h.pending[message.ID]
		h.mu.Unlock()
		if waiting != nil {
			waiting <- message
		}
	}
	h.fail(errors.New("the plugin host exited"))
}

func (h *Host) fail(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.dead == nil {
		h.dead = err
	}
	for id, waiting := range h.pending {
		select {
		case waiting <- reply{ID: id, Error: err.Error()}:
		default:
		}
	}
}

func (h *Host) request(ctx context.Context, method string, params, result any) error {
	h.mu.Lock()
	if h.dead != nil {
		err := h.dead
		h.mu.Unlock()
		return err
	}
	h.next++
	id := h.next
	waiting := make(chan reply, 1)
	h.pending[id] = waiting
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.pending, id); h.mu.Unlock() }()
	body, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	h.mu.Lock()
	_, err = h.stdin.Write(append(body, '\n'))
	h.mu.Unlock()
	if err != nil {
		return err
	}
	select {
	case message := <-waiting:
		if message.Error != "" {
			return errors.New(message.Error)
		}
		if result != nil && len(message.Result) > 0 {
			return json.Unmarshal(message.Result, result)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Call runs every plugin's hook of that name in load order. Each plugin may change output; the changed output comes
// back with the hooks that threw or timed out.
func (h *Host) Call(ctx context.Context, name string, input any, output json.RawMessage) (json.RawMessage, []Failure, error) {
	var result struct {
		Output   json.RawMessage `json:"output"`
		Failures []Failure       `json:"failures"`
	}
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(h.plugins*2+2)*h.timeout)
	defer cancel()
	if err := h.request(callCtx, "hook", map[string]any{"name": name, "input": input, "output": output}, &result); err != nil {
		return output, nil, err
	}
	return result.Output, result.Failures, nil
}

// RunTool runs a custom tool of a plugin and returns its text.
func (h *Host) RunTool(ctx context.Context, plugin, name string, args json.RawMessage, call ToolContext) (string, error) {
	var result struct {
		Output string `json:"output"`
	}
	if err := h.request(ctx, "tool", map[string]any{"plugin": plugin, "name": name, "args": args, "context": call}, &result); err != nil {
		return "", err
	}
	return result.Output, nil
}

// Notify tells every plugin about an engine event; it does not wait for them.
func (h *Host) Notify(event json.RawMessage) {
	ctx, cancel := context.WithTimeout(context.Background(), h.timeout)
	defer cancel()
	_ = h.request(ctx, "event", map[string]any{"event": event}, nil)
}

// Close lets the plugins dispose of what they own and stops the host.
func (h *Host) Close() error {
	h.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = h.request(ctx, "dispose", map[string]any{}, nil)
		cancel()
		_ = h.stdin.Close()
		select {
		case <-h.done:
		case <-time.After(2 * time.Second):
			if h.cmd.Process != nil {
				_ = h.cmd.Process.Kill()
			}
			<-h.done
		}
	})
	return nil
}
