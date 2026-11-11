// Package clienttool holds the tools that connected clients offer to the models. A tool lasts as long as its owner:
// when the connection closes, its tools are gone and a call that was already planned fails.
package clienttool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// Prefix starts the name of every client tool, so one never shadows a built-in tool.
const Prefix = "client__"

var namePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,48}$`)

// Definition describes one tool.
type Definition struct {
	Name        string
	Description string
	Schema      json.RawMessage
	Effect      tool.Effect
}

// Handler runs one call on the owner's side and returns the text of the result.
type Handler func(ctx context.Context, name string, input json.RawMessage) (text string, isError bool, err error)

type entry struct {
	owner   string
	spec    tool.Spec
	handler Handler
}

// Registry is the set of live client tools. The zero value is not usable; use New.
type Registry struct {
	mu      sync.Mutex
	entries map[string]*entry
}

func New() *Registry { return &Registry{entries: make(map[string]*entry)} }

// Register offers a tool of owner. A name another owner holds is refused; the same owner may replace its own tool.
func (r *Registry) Register(owner string, definition Definition, handler Handler) error {
	if !namePattern.MatchString(definition.Name) {
		return errors.New("a tool name has 1 to 48 letters, digits, - or _")
	}
	if definition.Description == "" {
		return errors.New("a tool needs a description")
	}
	schema := definition.Schema
	if len(schema) == 0 || string(schema) == "null" {
		schema = json.RawMessage(`{"type":"object"}`)
	}
	var shape struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(schema, &shape) != nil || shape.Type != "object" {
		return errors.New("the schema of a tool is a JSON schema of type object")
	}
	effect := definition.Effect
	if effect == "" {
		effect = tool.EffectExec
	}
	switch effect {
	case tool.EffectRead, tool.EffectWrite, tool.EffectExec, tool.EffectNetwork:
	default:
		return fmt.Errorf("unknown effect %q", effect)
	}
	name := Prefix + definition.Name
	r.mu.Lock()
	defer r.mu.Unlock()
	if held := r.entries[name]; held != nil && held.owner != owner {
		return fmt.Errorf("the tool %s is registered by another client", definition.Name)
	}
	r.entries[name] = &entry{owner: owner, handler: handler, spec: tool.Spec{Name: name, Description: definition.Description, Input: schema, Effect: effect}}
	return nil
}

// Unregister removes one tool of owner.
func (r *Registry) Unregister(owner, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if held := r.entries[Prefix+name]; held != nil && held.owner == owner {
		delete(r.entries, Prefix+name)
	}
}

// Drop removes every tool of owner.
func (r *Registry) Drop(owner string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, held := range r.entries {
		if held.owner == owner {
			delete(r.entries, name)
		}
	}
}

// Names lists the registered tools, sorted.
func (r *Registry) Names() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := make([]string, 0, len(r.entries))
	for name := range r.entries {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Tools returns one tool for each registered name. Each looks its entry up when it runs, so a tool that was
// unregistered after a session listed it fails instead of reaching a client that is gone.
func (r *Registry) Tools() []tool.Tool {
	r.mu.Lock()
	defer r.mu.Unlock()
	tools := make([]tool.Tool, 0, len(r.entries))
	for name, held := range r.entries {
		tools = append(tools, live{registry: r, name: name, spec: held.spec})
	}
	return tools
}

type live struct {
	registry *Registry
	name     string
	spec     tool.Spec
}

func (l live) Spec() tool.Spec { return l.spec }

func (l live) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	l.registry.mu.Lock()
	held := l.registry.entries[l.name]
	l.registry.mu.Unlock()
	if held == nil {
		return tool.Fail(fmt.Errorf("the tool %s doesn't exist", l.name)), nil
	}
	text, isError, err := held.handler(ctx, l.name[len(Prefix):], call.Input)
	if err != nil {
		if ctx.Err() != nil {
			return tool.Result{}, ctx.Err()
		}
		return tool.Fail(err), nil
	}
	if isError {
		return tool.Result{IsError: true, Code: "MRK-5001", Parts: []model.Part{{Text: text}}}, nil
	}
	return tool.Result{Parts: []model.Part{{Text: text}}}, nil
}
