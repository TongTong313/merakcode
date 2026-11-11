// Package event defines the facts emitted by the engine and their delivery bus.
package event

import (
	"encoding/json"
	"time"
)

type ID string
type Stream string
type Type string

const Lagged Type = "events.lagged"

type Scope struct {
	Group   ID `json:"group,omitempty"`
	Task    ID `json:"task,omitempty"`
	Session ID `json:"session,omitempty"`
	Turn    ID `json:"turn,omitempty"`
}

type ActorKind string

const (
	ActorHuman    ActorKind = "human"
	ActorAgent    ActorKind = "agent"
	ActorExternal ActorKind = "external"
	ActorSystem   ActorKind = "system"
)

type Actor struct {
	Kind ActorKind `json:"kind"`
	ID   ID        `json:"id,omitempty"`
}

type Event struct {
	ID      ID              `json:"id"`
	Stream  Stream          `json:"stream"`
	Seq     uint64          `json:"seq,omitempty"`
	Time    time.Time       `json:"time"`
	Type    Type            `json:"type"`
	Scope   Scope           `json:"scope"`
	Actor   Actor           `json:"actor"`
	Cause   ID              `json:"cause,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

// Transient reports whether an event is only delivered live and occupies no stored position.
func Transient(kind Type) bool { return kind == "message.delta" }

func Decode[T any](e Event) (T, error) {
	var value T
	err := json.Unmarshal(e.Payload, &value)
	return value, err
}
