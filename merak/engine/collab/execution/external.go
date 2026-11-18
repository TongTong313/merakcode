package execution

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func init() { event.Register[map[string]json.RawMessage]("external.*") }

// EmitEvent accepts external facts without exposing engine-owned event identities.
func (domain *Execution) EmitEvent(ctx context.Context, groupID event.ID, kind event.Type, payload json.RawMessage) (event.Event, error) {
	name := string(kind)
	if !strings.HasPrefix(name, "external.") || len(name) == len("external.") || strings.ContainsFunc(name, func(r rune) bool { return unicode.IsSpace(r) || r == 0 || r == '\ufeff' }) {
		return event.Event{}, errors.New("external event types require a nonempty external. prefix")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(payload, &object); err != nil || object == nil {
		return event.Event{}, errors.New("external event payload must be a JSON object")
	}
	if _, err := domain.groups.Get(ctx, groupID); err != nil {
		return event.Event{}, err
	}
	return domain.core.Bus.Publish(ctx, event.Event{Stream: event.Stream("group:" + groupID), Scope: event.Scope{Group: groupID}, Type: kind, Actor: event.Actor{Kind: event.ActorExternal}, Payload: payload})
}
