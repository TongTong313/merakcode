package plugin

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/tool"
)

// Failed is published when a hook of a plugin throws or does not answer in time. The turn goes on without it.
const Failed event.Type = "plugin.failed"

// FailedEvent is the payload of Failed.
type FailedEvent struct {
	Plugin string `json:"plugin"`
	Hook   string `json:"hook"`
	Error  string `json:"error"`
	Code   string `json:"code"`
}

func init() { event.Register[FailedEvent](Failed) }

// ToolPrefix starts the name of every custom tool of a plugin: plugin__<plugin>__<tool>.
const ToolPrefix = "plugin__"

// Session is the plugins of one conversation: a running host and what the engine needs to call its hooks.
type Session struct {
	Host     *Host
	Statuses []Status
	// ID is the conversation the hooks run for.
	ID string
	// Report is told about each hook that failed.
	Report func(ctx context.Context, failure FailedEvent)

	has map[string]bool

	closing   chan struct{}
	forwarder sync.WaitGroup
	closeOnce sync.Once
}

// NewSession makes the session of a started host.
func NewSession(host *Host, statuses []Status, id string, report func(context.Context, FailedEvent)) *Session {
	s := &Session{Host: host, Statuses: statuses, ID: id, Report: report, has: make(map[string]bool), closing: make(chan struct{})}
	for _, status := range statuses {
		for _, hook := range status.Hooks {
			s.has[hook] = true
		}
	}
	return s
}

// Has says whether any plugin has the hook.
func (s *Session) Has(hook string) bool { return s != nil && s.has[hook] }

func (s *Session) call(ctx context.Context, hook string, input any, output json.RawMessage) json.RawMessage {
	if !s.Has(hook) {
		return output
	}
	changed, failures, err := s.Host.Call(ctx, hook, input, output)
	for _, failure := range failures {
		if s.Report != nil {
			s.Report(ctx, FailedEvent{Plugin: failure.Plugin, Hook: hook, Error: failure.Error, Code: "MRK-5012"})
		}
	}
	if err != nil {
		if s.Report != nil && ctx.Err() == nil {
			s.Report(ctx, FailedEvent{Hook: hook, Error: err.Error(), Code: "MRK-5012"})
		}
		return output
	}
	if len(changed) == 0 {
		return output
	}
	return changed
}

// Tools returns the custom tools of the loaded plugins, named plugin__<plugin>__<tool>. They are meant for the
// deferred pool, behind the permission gate.
func (s *Session) Tools() []tool.Tool {
	var tools []tool.Tool
	for _, status := range s.Statuses {
		if status.State != "loaded" {
			continue
		}
		for _, declared := range status.Tools {
			schema := declared.Schema
			if len(schema) == 0 {
				schema = json.RawMessage(`{"type":"object"}`)
			}
			tools = append(tools, custom{session: s, plugin: status.ID, name: declared.Name, spec: tool.Spec{
				Name: ToolPrefix + status.ID + "__" + declared.Name, Description: declared.Description, Input: schema, Effect: tool.EffectExec,
			}})
		}
	}
	return tools
}

type custom struct {
	session *Session
	plugin  string
	name    string
	spec    tool.Spec
}

func (c custom) Spec() tool.Spec { return c.spec }

func (c custom) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	text, err := c.session.Host.RunTool(ctx, c.plugin, c.name, call.Input, ToolContext{Session: c.session.ID, Call: call.ID})
	if err != nil {
		if ctx.Err() != nil {
			return tool.Result{}, ctx.Err()
		}
		return tool.Fail(err), nil
	}
	return tool.Result{Parts: []model.Part{{Text: text}}}, nil
}

// Wrap puts the tool.execute.before and tool.execute.after hooks around a tool. The hooks see and may change the
// arguments before the tool, the permission gate inside it included, and its text after. A tool with its definition
// changed by a tool.definition hook shows the changed description to the model.
func (s *Session) Wrap(t tool.Tool) tool.Tool {
	if !s.Has("tool.execute.before") && !s.Has("tool.execute.after") && !s.Has("tool.definition") {
		return t
	}
	return hooked{session: s, inner: t, spec: s.definition(t.Spec())}
}

func (s *Session) definition(spec tool.Spec) tool.Spec {
	if !s.Has("tool.definition") {
		return spec
	}
	body, _ := json.Marshal(map[string]any{"description": spec.Description, "parameters": json.RawMessage(spec.Input)})
	changed := s.call(context.Background(), "tool.definition", map[string]string{"toolID": spec.Name}, body)
	var output struct {
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	}
	if json.Unmarshal(changed, &output) != nil {
		return spec
	}
	if output.Description != "" {
		spec.Description = output.Description
	}
	if len(output.Parameters) > 0 && string(output.Parameters) != "null" {
		spec.Input = output.Parameters
	}
	return spec
}

type hooked struct {
	session *Session
	inner   tool.Tool
	spec    tool.Spec
}

func (h hooked) Spec() tool.Spec { return h.spec }

func (h hooked) Run(ctx context.Context, call tool.Call) (tool.Result, error) {
	info := map[string]string{"tool": h.spec.Name, "sessionID": h.session.ID, "callID": call.ID}
	args := call.Input
	if len(args) == 0 {
		args = json.RawMessage(`{}`)
	}
	before, _ := json.Marshal(map[string]json.RawMessage{"args": args})
	var changed struct {
		Args json.RawMessage `json:"args"`
	}
	if json.Unmarshal(h.session.call(ctx, "tool.execute.before", info, before), &changed) == nil && len(changed.Args) > 0 && string(changed.Args) != "null" {
		call.Input = changed.Args
	}
	result, err := h.inner.Run(ctx, call)
	if err != nil || !h.session.Has("tool.execute.after") {
		return result, err
	}
	for _, part := range result.Parts {
		if part.Text == "" || part.Image != nil || part.Document != nil || part.ToolCall != nil || part.ToolResult != nil {
			return result, nil
		}
	}
	var text strings.Builder
	for _, part := range result.Parts {
		text.WriteString(part.Text)
	}
	after, _ := json.Marshal(map[string]any{"title": h.spec.Name, "output": text.String(), "metadata": map[string]any{}})
	var output struct {
		Output string `json:"output"`
	}
	if json.Unmarshal(h.session.call(ctx, "tool.execute.after", map[string]any{"tool": h.spec.Name, "sessionID": h.session.ID, "callID": call.ID, "args": json.RawMessage(call.Input)}, after), &output) == nil && output.Output != text.String() {
		result.Parts = []model.Part{{Text: output.Output}}
	}
	return result, nil
}

// Params runs the chat.params hook over the sampling parameters of a request. A value a plugin leaves alone stays
// as it was.
func (s *Session) Params(ctx context.Context, request *model.Request) {
	if !s.Has("chat.params") {
		return
	}
	output, _ := json.Marshal(map[string]any{"temperature": request.Temperature, "topP": request.TopP, "topK": request.TopK, "maxOutputTokens": nil, "options": map[string]any{}})
	input := map[string]any{"sessionID": s.ID, "agent": "build", "model": map[string]string{"id": request.Model}}
	var changed struct {
		Temperature     *float64 `json:"temperature"`
		TopP            *float64 `json:"topP"`
		TopK            *int     `json:"topK"`
		MaxOutputTokens *int     `json:"maxOutputTokens"`
	}
	if json.Unmarshal(s.call(ctx, "chat.params", input, output), &changed) != nil {
		return
	}
	request.Temperature, request.TopP, request.TopK = changed.Temperature, changed.TopP, changed.TopK
	if changed.MaxOutputTokens != nil && *changed.MaxOutputTokens > 0 {
		request.MaxTokens = *changed.MaxOutputTokens
	}
}

// Message runs the chat.message hook over the text parts of a message of the user before it enters the history.
func (s *Session) Message(ctx context.Context, parts []model.Part) []model.Part {
	if !s.Has("chat.message") {
		return parts
	}
	type part struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	var visible []part
	var places []int
	for i, p := range parts {
		if p.Text != "" && p.Image == nil && p.Document == nil && p.ToolCall == nil && p.ToolResult == nil && p.Reasoning == nil {
			visible, places = append(visible, part{Type: "text", Text: p.Text}), append(places, i)
		}
	}
	output, _ := json.Marshal(map[string]any{"message": map[string]any{"role": "user"}, "parts": visible})
	var changed struct {
		Parts []part `json:"parts"`
	}
	if json.Unmarshal(s.call(ctx, "chat.message", map[string]string{"sessionID": s.ID}, output), &changed) != nil || len(changed.Parts) != len(places) {
		return parts
	}
	result := slices.Clone(parts)
	for i, place := range places {
		result[place].Text = changed.Parts[i].Text
	}
	return result
}

// PermissionAsk runs the permission.ask hook. It returns "allow", "deny" or "ask" (the last when no plugin decided);
// it runs after the policy of the engine decided to ask and before a person is asked.
func (s *Session) PermissionAsk(ctx context.Context, name string, input json.RawMessage) string {
	if !s.Has("permission.ask") {
		return "ask"
	}
	request, _ := json.Marshal(map[string]any{"sessionID": s.ID, "type": name, "pattern": name, "metadata": map[string]any{"input": json.RawMessage(input)}})
	var changed struct {
		Status string `json:"status"`
	}
	output := json.RawMessage(`{"status":"ask"}`)
	if json.Unmarshal(s.call(ctx, "permission.ask", json.RawMessage(request), output), &changed) != nil {
		return "ask"
	}
	switch changed.Status {
	case "allow", "deny":
		return changed.Status
	}
	return "ask"
}

// ShellEnv runs the shell.env hook: the variables the plugins add to a command of the shell tool.
func (s *Session) ShellEnv(ctx context.Context, cwd, callID string) map[string]string {
	if !s.Has("shell.env") {
		return nil
	}
	var changed struct {
		Env map[string]string `json:"env"`
	}
	input := map[string]string{"cwd": cwd, "sessionID": s.ID, "callID": callID}
	if json.Unmarshal(s.call(ctx, "shell.env", input, json.RawMessage(`{"env":{}}`)), &changed) != nil {
		return nil
	}
	return changed.Env
}

// Watch forwards the events of facts to the plugins until the session closes; Close first hands over the events
// that are already waiting, so a plugin sees the last event of a turn. stop ends the subscription.
func (s *Session) Watch(facts <-chan event.Event, stop func()) {
	if !s.Has("event") {
		stop()
		return
	}
	s.forwarder.Add(1)
	go func() {
		defer s.forwarder.Done()
		defer stop()
		for {
			select {
			case fact, ok := <-facts:
				if !ok {
					return
				}
				s.Notify(fact)
			case <-s.closing:
				for {
					select {
					case fact, ok := <-facts:
						if !ok {
							return
						}
						s.Notify(fact)
					default:
						return
					}
				}
			}
		}
	}()
}

// Close delivers the waiting events, lets the plugins dispose of what they own and stops the host.
func (s *Session) Close() error {
	s.closeOnce.Do(func() {
		close(s.closing)
		s.forwarder.Wait()
	})
	return s.Host.Close()
}

// Notify forwards an engine event to the plugins that have an event hook.
func (s *Session) Notify(fact event.Event) {
	if !s.Has("event") {
		return
	}
	body, err := json.Marshal(fact)
	if err != nil {
		return
	}
	s.Host.Notify(body)
}
