package event

import (
	"encoding/json"

	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type deltaKey struct {
	Stream        Stream
	Session, Turn ID
	Channel       string
}

type deltaRedaction struct {
	Filter secret.Stream
	Last   Event
}

// redactDelta runs while the bus lock preserves fragment ordering.
func (b *Bus) redactDelta(e *Event) error {
	complete := e.Type == "turn.finished"
	if e.Type == "message.completed" && len(e.Payload) > 0 {
		var payload struct {
			Parts []json.RawMessage `json:"parts"`
		}
		_ = json.Unmarshal(e.Payload, &payload)
		complete = len(payload.Parts) > 0
	}
	if complete {
		for key, state := range b.redactions {
			if key.Stream == e.Stream && key.Session == e.Scope.Session && key.Turn == e.Scope.Turn {
				if text := state.Filter.Finish(); text != "" {
					fact := state.Last
					fact.ID, fact.Time, fact.Seq = b.newID(), e.Time, 0
					fact.Payload = replaceDeltaText(fact.Payload, key.Channel, text)
					b.deliver(fact)
				}
				delete(b.redactions, key)
			}
		}
	}
	if e.Type != "message.delta" || len(e.Payload) == 0 {
		return nil
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(e.Payload, &body); err != nil {
		return err
	}
	var kind string
	if value, ok := body["kind"]; ok {
		if err := json.Unmarshal(value, &kind); err != nil {
			return err
		}
	}
	target := body
	if kind == "reasoning" {
		target = map[string]json.RawMessage{}
		if err := json.Unmarshal(body["reasoning"], &target); err != nil {
			return err
		}
	}
	value, ok := target["text"]
	if !ok {
		return nil
	}
	var text string
	if err := json.Unmarshal(value, &text); err != nil {
		return err
	}
	key := deltaKey{e.Stream, e.Scope.Session, e.Scope.Turn, kind}
	stream := b.redactions[key]
	if stream == nil {
		stream = new(deltaRedaction)
		b.redactions[key] = stream
	}
	stream.Last = *e
	clean := stream.Filter.Append(text)
	if clean == text {
		return nil
	}
	target["text"], _ = json.Marshal(clean)
	if kind == "reasoning" {
		body["reasoning"], _ = json.Marshal(target)
	}
	e.Payload, _ = json.Marshal(body)
	return nil
}

func replaceDeltaText(payload json.RawMessage, kind, text string) json.RawMessage {
	var body map[string]json.RawMessage
	_ = json.Unmarshal(payload, &body)
	value, _ := json.Marshal(text)
	if kind == "reasoning" {
		var reasoning map[string]json.RawMessage
		_ = json.Unmarshal(body["reasoning"], &reasoning)
		reasoning["text"] = value
		body["reasoning"], _ = json.Marshal(reasoning)
	} else {
		body["text"] = value
	}
	result, _ := json.Marshal(body)
	return result
}
