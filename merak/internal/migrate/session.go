package migrate

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

// loaded is a conversation of v0.3 as read from the database: its info and its messages with their parts, all
// decoded. Nothing is written until the whole conversation has decoded.
type loaded struct {
	info     v03Session
	messages []loadedMessage
}

type loadedMessage struct {
	info  v03Message
	parts []v03Part
}

// load reads and decodes a conversation. A damaged item fails the whole conversation.
func load(ctx context.Context, db *source, info v03Session) (loaded, error) {
	result := loaded{info: info}
	rows, err := db.messages(ctx, info.ID)
	if err != nil {
		return result, err
	}
	parts, err := db.parts(ctx, info.ID)
	if err != nil {
		return result, err
	}
	byMessage := map[string][]v03Part{}
	for _, row := range parts {
		part, err := decode[v03Part]("part", row.ID, row.Data)
		if err != nil {
			return result, err
		}
		byMessage[row.Message] = append(byMessage[row.Message], part)
	}
	for _, row := range rows {
		message, err := decode[v03Message]("message", row.ID, row.Data)
		if err != nil {
			return result, err
		}
		result.messages = append(result.messages, loadedMessage{info: message, parts: byMessage[row.ID]})
	}
	slices.SortStableFunc(result.messages, func(a, b loadedMessage) int {
		return int(a.info.Time.Created - b.info.Time.Created)
	})
	return result, nil
}

// builder turns one conversation into the events of a v1 session. It folds each event into a scratch state, so a
// summary can name how many messages it replaces.
type builder struct {
	engine   *engine.Engine
	ctx      context.Context
	old      event.ID
	facts    []event.Event
	scratch  session.State
	last     time.Time
	blobs    int
	messages int
}

func (b *builder) add(kind event.Type, at time.Time, actor event.Actor, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if at.Before(b.last) {
		at = b.last
	}
	b.last = at
	fact := event.Event{ID: event.NewID(), Stream: event.Stream("session:" + b.old), Seq: uint64(len(b.facts) + 1), Time: at, Type: kind, Scope: event.Scope{Session: b.old}, Actor: actor, Payload: body}
	if err := session.Fold(&b.scratch, fact); err != nil {
		return err
	}
	b.facts = append(b.facts, fact)
	return nil
}

var (
	humanActor = event.Actor{Kind: event.ActorHuman}
	agentActor = event.Actor{Kind: event.ActorAgent}
)

// mode maps the permission level of v0.3. Full takeover is never carried over: v1 asks for a confirmation each time
// it is chosen.
func mode(level string) permission.Mode {
	if level == "autoApprove" {
		return permission.ModeAuto
	}
	return permission.ModeAsk
}

func thinking(variant string) model.Thinking {
	switch value := model.Thinking(variant); value {
	case model.ThinkingOff, model.ThinkingLow, model.ThinkingMedium, model.ThinkingHigh, model.ThinkingXHigh, model.ThinkingMax:
		return value
	}
	return ""
}

// conversationFacts builds the events of a v1 session out of a conversation of v0.3: parent is the v1 id of its
// parent, or empty. The todo list, when there is one, ends the history.
func conversationFacts(ctx context.Context, e *engine.Engine, from loaded, parent event.ID, todos []tool.Todo) (facts []event.Event, blobs, messages int, err error) {
	b := &builder{engine: e, ctx: ctx, old: event.ID(from.info.ID)}
	info := from.info
	created := ms(info.Time.Created)
	config := session.Config{Parent: parent, Mode: mode(info.PermissionLevel), Workdir: info.Directory}
	for _, message := range from.messages {
		if message.info.Role == "user" && message.info.Model.ProviderID != "" {
			config.Provider, config.Model, config.Thinking = message.info.Model.ProviderID, message.info.Model.ModelID, thinking(message.info.Variant)
		}
	}
	if config.Provider == "" {
		for _, message := range from.messages {
			if message.info.Role == "assistant" && message.info.ProviderID != "" {
				config.Provider, config.Model = message.info.ProviderID, message.info.ModelID
			}
		}
	}
	title := info.Title
	if defaultTitle.MatchString(title) {
		title = ""
	}
	state := session.State{ID: b.old, Title: title, Archived: info.Time.Archived > 0, Config: config}
	if err := b.add(session.Created, created, humanActor, state); err != nil {
		return nil, 0, 0, err
	}
	if _, statErr := os.Stat(info.Directory); statErr != nil {
		if err := b.add(session.Warning, created, agentActor, session.Diagnostic{Code: errorcode.ImportDirectoryMissing}); err != nil {
			return nil, 0, 0, err
		}
	}
	for _, message := range from.messages {
		if err := b.message(message); err != nil {
			return nil, 0, 0, err
		}
	}
	if len(todos) > 0 {
		if err := b.add(session.TodoUpdated, b.last, agentActor, session.Todos{Items: todos}); err != nil {
			return nil, 0, 0, err
		}
	}
	if updated := ms(info.Time.Updated); updated.After(b.last) {
		if err := b.add(session.Updated, updated, humanActor, session.Change{}); err != nil {
			return nil, 0, 0, err
		}
	}
	return b.facts, b.blobs, b.messages, nil
}

func (b *builder) message(message loadedMessage) error {
	info := message.info
	switch {
	case info.Role == "user":
		parts, err := b.userParts(message.parts)
		if err != nil || len(parts) == 0 {
			return err
		}
		b.messages++
		return b.add(session.MessageSent, ms(info.Time.Created), humanActor, session.Completion{Message: model.Message{Role: model.User, Parts: parts}})
	case info.isSummary():
		return b.summary(message)
	case info.Role == "assistant":
		return b.assistant(message)
	}
	return nil
}

// summary turns the summary of a compaction into the replacement of everything said before it.
func (b *builder) summary(message loadedMessage) error {
	var text strings.Builder
	for _, part := range message.parts {
		if part.Type == "text" && !part.Ignored {
			text.WriteString(part.Text)
		}
	}
	if strings.TrimSpace(text.String()) == "" {
		return nil
	}
	summary := model.Message{Role: model.User, Parts: []model.Part{{Text: text.String()}}}
	if len(b.scratch.Messages) == 0 {
		b.messages++
		return b.add(session.MessageCompleted, ms(message.info.Time.Created), agentActor, session.Completion{Message: model.Message{Role: model.Assistant, Parts: summary.Parts}})
	}
	return b.add(session.Rebuilt, ms(message.info.Time.Created), agentActor, session.Rebuild{To: len(b.scratch.Messages), ThroughSeq: b.scratch.LastSeq, SummaryID: event.NewID(), Summary: summary})
}

func (b *builder) userParts(parts []v03Part) ([]model.Part, error) {
	var result []model.Part
	for _, part := range parts {
		switch part.Type {
		case "text":
			if !part.Ignored && part.Text != "" {
				result = append(result, model.Part{Text: part.Text})
			}
		case "file":
			attached, ok, err := b.attachment(part)
			if err != nil {
				return nil, err
			}
			if ok {
				result = append(result, attached)
			}
		}
	}
	return result, nil
}

// skippedMime are the file parts that v0.3 itself did not send on: their content is in synthetic text parts.
var skippedMime = []string{"text/plain", "application/x-directory", "application/x-merakcode-session"}

// attachment turns a file part: inline data of an image is stored as a blob and referred to, any other inline data
// is kept in the message, and a file on disk keeps its path.
func (b *builder) attachment(part v03Part) (model.Part, bool, error) {
	if slices.Contains(skippedMime, part.Mime) || part.URL == "" {
		return model.Part{}, false, nil
	}
	data, mime, inline := inlineData(part.URL)
	if !inline {
		return model.Part{Text: "[file: " + strings.TrimPrefix(part.URL, "file://") + "]"}, true, nil
	}
	if mime == "" {
		mime = part.Mime
	}
	name := part.Filename
	if name == "" {
		name = "attachment"
	}
	if strings.HasPrefix(mime, "image/") {
		ref, err := b.engine.PutBlob(b.ctx, name, data)
		if err != nil {
			return model.Part{}, false, err
		}
		b.blobs++
		return model.Part{Image: &model.Image{MIME: mime, URL: ref}}, true, nil
	}
	return model.Part{Document: &model.Document{MIME: mime, Name: name, Data: data}}, true, nil
}

// inlineData reads a data: URL.
func inlineData(address string) (data []byte, mime string, ok bool) {
	rest, found := strings.CutPrefix(address, "data:")
	if !found {
		return nil, "", false
	}
	header, body, found := strings.Cut(rest, ",")
	if !found {
		return nil, "", false
	}
	mime, encoding, _ := strings.Cut(header, ";")
	if strings.HasSuffix(header, ";base64") {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return nil, "", false
		}
		return decoded, mime, true
	}
	_ = encoding
	text, err := url.PathUnescape(body)
	if err != nil {
		return nil, "", false
	}
	return []byte(text), mime, true
}

// step is the parts of one model step of an assistant message: v0.3 keeps a whole run of steps in one message.
type step struct{ parts []v03Part }

func steps(parts []v03Part) []step {
	var result []step
	var current step
	flush := func() {
		if len(current.parts) > 0 {
			result = append(result, current)
		}
		current = step{}
	}
	for _, part := range parts {
		if part.Type == "step-start" {
			flush()
			continue
		}
		current.parts = append(current.parts, part)
		if part.Type == "step-finish" {
			flush()
		}
	}
	flush()
	return result
}

var errInterrupted = errors.New("interrupted")

func (b *builder) assistant(message loadedMessage) error {
	for _, one := range steps(message.parts) {
		var parts []model.Part
		var calls []v03Part
		var usage model.Usage
		for _, part := range one.parts {
			switch part.Type {
			case "reasoning":
				if part.Text != "" {
					// Provider "imported" never equals a provider's name, so no provider sends this thinking back
					// without the signature that v0.3 did not keep.
					parts = append(parts, model.Part{Reasoning: &model.Reasoning{Text: part.Text, Provider: "imported"}})
				}
			case "text":
				if !part.Ignored && part.Text != "" {
					parts = append(parts, model.Part{Text: part.Text})
				}
			case "tool":
				input := json.RawMessage(`{}`)
				var state v03ToolState
				if len(part.State) > 0 {
					if err := json.Unmarshal(part.State, &state); err != nil {
						return decodeError{"tool part", part.ID}
					}
					if len(state.Input) > 0 && string(state.Input) != "null" {
						input = state.Input
					}
				}
				callID := part.CallID
				if callID == "" {
					callID = part.ID
				}
				part.CallID = callID
				parts = append(parts, model.Part{ToolCall: &model.ToolCall{ID: callID, Name: part.Tool, Input: input}})
				calls = append(calls, part)
			case "step-finish":
				usage = model.Usage{Input: part.Tokens.Input, Output: part.Tokens.Output, CacheRead: part.Tokens.Cache.Read, CacheWrite: part.Tokens.Cache.Write}
			}
		}
		if len(parts) == 0 {
			continue
		}
		b.messages++
		completed := ms(message.info.Time.Completed)
		if message.info.Time.Completed == 0 {
			completed = ms(message.info.Time.Created)
		}
		if err := b.add(session.MessageCompleted, completed, agentActor, session.Completion{Message: model.Message{Role: model.Assistant, Parts: parts}, Usage: usage}); err != nil {
			return err
		}
		for _, call := range calls {
			if err := b.result(call, completed); err != nil {
				return err
			}
		}
	}
	return nil
}

// result records what became of a tool call. A call that never finished gets an interrupted result, since every
// call in a history needs one.
func (b *builder) result(call v03Part, fallback time.Time) error {
	var state v03ToolState
	if len(call.State) > 0 {
		if err := json.Unmarshal(call.State, &state); err != nil {
			return decodeError{"tool part", call.ID}
		}
	}
	at := fallback
	if state.Time.End > 0 {
		at = ms(state.Time.End)
	}
	completion := tool.Completion{CallID: call.CallID, Name: call.Tool, Result: tool.Result{Parts: []model.Part{}}}
	switch state.Status {
	case "completed":
		if state.Output != "" {
			completion.Parts = append(completion.Parts, model.Part{Text: state.Output})
		}
		for _, file := range state.Attachments {
			attached, ok, err := b.attachment(file)
			if err != nil {
				return err
			}
			if ok {
				completion.Parts = append(completion.Parts, attached)
			}
		}
	case "error":
		completion.IsError = true
		if state.Error != "" {
			completion.Parts = append(completion.Parts, model.Part{Text: state.Error})
		}
	default:
		completion.IsError, completion.Code = true, errorcode.ToolInterrupted
		completion.Parts = append(completion.Parts, model.Part{Text: errInterrupted.Error()})
	}
	return b.add(tool.Completed, at, agentActor, completion)
}
