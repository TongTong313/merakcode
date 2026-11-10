package engine

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/loop"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

// cloudEvent keeps the durable envelope while removing file bodies from its wire copy.
func (e *Engine) cloudEvent(ctx context.Context, fact event.Event) (event.Event, error) {
	var payload any
	switch fact.Type {
	case session.Created:
		state, err := event.Decode[session.State](fact)
		if err != nil {
			return fact, err
		}
		state.System = ""
		for i := range state.Messages {
			e.cloudParts(ctx, fact, state.Messages[i].Parts)
		}
		for key, call := range state.Open {
			cloudToolCall(&call)
			state.Open[key] = call
		}
		payload = state
	case loop.TurnFinished:
		outcome, err := event.Decode[loop.Outcome](fact)
		if err != nil {
			return fact, err
		}
		e.cloudParts(ctx, fact, outcome.Final)
		payload = outcome
	case tool.Progressed:
		progress, err := event.Decode[tool.Progress](fact)
		if err != nil {
			return fact, err
		}
		var raw any
		if json.Unmarshal(progress.Raw, &raw) == nil {
			progress.Raw, _ = json.Marshal(cloudProgressMetadata(raw))
		} else {
			progress.Raw = nil
		}
		payload = progress
	case tool.Called:
		call, err := event.Decode[model.ToolCall](fact)
		if err != nil {
			return fact, err
		}
		cloudToolCall(&call)
		payload = call
	case permission.Requested, permission.Routed, permission.Escalated:
		request, err := event.Decode[permission.Request](fact)
		if err != nil {
			return fact, err
		}
		call := model.ToolCall{ID: request.Call.ID, Name: request.Call.Name, Input: request.Call.Input}
		cloudToolCall(&call)
		request.Call.Input = call.Input
		payload = request
	case tool.Completed:
		result, err := event.Decode[tool.Completion](fact)
		if err != nil {
			return fact, err
		}
		call := e.cloudResultCall(ctx, fact, result.CallID)
		result.Parts = cloudResultParts(call, result.Parts)
		e.cloudParts(ctx, fact, result.Parts)
		payload = result
	case session.MessageCompleted:
		message, err := event.Decode[session.Completion](fact)
		if err != nil {
			return fact, err
		}
		e.cloudParts(ctx, fact, message.Parts)
		payload = message
	case session.MessageSent:
		message, err := event.Decode[session.Input](fact)
		if err != nil {
			return fact, err
		}
		e.cloudParts(ctx, fact, message.Parts)
		payload = message
	case session.MessageDelta:
		chunk, err := event.Decode[model.Chunk](fact)
		if err != nil {
			return fact, err
		}
		if chunk.Kind == model.ToolCallDelta {
			chunk.Text = ""
		}
		if chunk.ToolCall != nil {
			cloudToolCall(chunk.ToolCall)
		}
		payload = chunk
	}
	if payload != nil {
		body, err := json.Marshal(payload)
		if err != nil {
			return fact, err
		}
		fact.Payload = body
	}
	clean, err := secret.RedactJSON(fact.Payload)
	fact.Payload = clean
	return fact, err
}

// External progress payloads have product-specific fields; only file metadata leaves the device.
func cloudProgressMetadata(value any) map[string]any {
	paths := map[string]bool{}
	lines := 0
	var visit func(any)
	visit = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			for key, child := range item {
				if text, ok := child.(string); ok {
					switch strings.ToLower(key) {
					case "path", "filepath", "file_path":
						paths[text] = true
					default:
						lines += lineCount(text)
					}
					continue
				}
				visit(child)
			}
		case []any:
			for _, child := range item {
				visit(child)
			}
		case string:
			lines += lineCount(item)
		}
	}
	visit(value)
	files := make([]string, 0, len(paths))
	for path := range paths {
		files = append(files, path)
	}
	sort.Strings(files)
	return map[string]any{"paths": files, "lines": lines}
}

func (e *Engine) cloudParts(ctx context.Context, fact event.Event, parts []model.Part) {
	for i := range parts {
		part := &parts[i]
		if part.ToolCall != nil {
			cloudToolCall(part.ToolCall)
		}
		if part.Image != nil {
			part.Image.Data = nil
			if strings.HasPrefix(part.Image.URL, "data:") {
				part.Image.URL = ""
			}
		}
		if part.Document != nil {
			part.Document.Data = nil
		}
		if part.ToolResult != nil {
			result := part.ToolResult
			call := e.cloudResultCall(ctx, fact, result.CallID)
			result.Parts = cloudResultParts(call, result.Parts)
			e.cloudParts(ctx, fact, result.Parts)
		}
	}
}

func (e *Engine) cloudResultCall(ctx context.Context, fact event.Event, id string) model.ToolCall {
	scope := fact.Scope
	if scope.Session == "" {
		scope.Session = event.ID(strings.TrimPrefix(string(fact.Stream), "session:"))
	}
	facts, err := e.store.Find(ctx, store.Query{Scope: event.Scope{Session: scope.Session}, Types: []event.Type{tool.Called}})
	if err != nil {
		return model.ToolCall{}
	}
	for i := len(facts) - 1; i >= 0; i-- {
		if facts[i].Seq >= fact.Seq && facts[i].Stream == fact.Stream {
			continue
		}
		call, err := event.Decode[model.ToolCall](facts[i])
		if err == nil && call.ID == id {
			if call.Name == "call_tool" {
				var nested model.ToolCall
				if json.Unmarshal(call.Input, &nested) == nil {
					call = nested
				}
			}
			return call
		}
	}
	return model.ToolCall{}
}

func cloudResultParts(call model.ToolCall, parts []model.Part) []model.Part {
	name := strings.ToLower(call.Name)
	if name == "grep" || strings.HasSuffix(name, "__grep") {
		return cloudGrepParts(parts)
	}
	var input struct {
		Path     string `json:"path"`
		FilePath string `json:"file_path"`
	}
	_ = json.Unmarshal(call.Input, &input)
	if input.Path == "" {
		input.Path = input.FilePath
	}
	lines := 0
	for _, part := range parts {
		lines += lineCount(part.Text)
	}
	body, _ := json.Marshal(map[string]any{"path": input.Path, "lines": lines})
	return []model.Part{{Text: string(body)}}
}

var grepLocation = regexp.MustCompile(`^(.+?):[0-9]+:`)

func cloudGrepParts(parts []model.Part) []model.Part {
	counts := map[string]int{}
	for _, part := range parts {
		for _, line := range strings.Split(part.Text, "\n") {
			if match := grepLocation.FindStringSubmatch(line); len(match) == 2 {
				counts[match[1]]++
			}
		}
	}
	paths := make([]string, 0, len(counts))
	for path := range counts {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	files := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		files = append(files, map[string]any{"path": path, "lines": counts[path]})
	}
	body, _ := json.Marshal(map[string]any{"files": files})
	return []model.Part{{Text: string(body)}}
}

func cloudToolCall(call *model.ToolCall) {
	var input map[string]any
	if json.Unmarshal(call.Input, &input) != nil {
		return
	}
	if call.Name == "call_tool" {
		var nested model.ToolCall
		if json.Unmarshal(call.Input, &nested) == nil {
			cloudToolCall(&nested)
			input["input"] = nested.Input
		}
	}
	cloudToolData(input)
	call.Input, _ = json.Marshal(input)
}

func cloudToolData(value any) {
	switch object := value.(type) {
	case map[string]any:
		for key, child := range object {
			switch strings.ToLower(key) {
			case "content", "oldtext", "newtext", "old_string", "new_string", "diff", "patch", "rawoutput", "aggregatedoutput", "stdout", "stderr", "command", "output", "text", "data":
				if text, ok := child.(string); ok {
					delete(object, key)
					object[key+"Lines"] = lineCount(text)
					continue
				}
			}
			cloudToolData(child)
		}
	case []any:
		for _, child := range object {
			cloudToolData(child)
		}
	}
}

func lineCount(text string) int {
	if text == "" {
		return 0
	}
	lines := strings.Count(text, "\n")
	if !strings.HasSuffix(text, "\n") {
		lines++
	}
	return lines
}
