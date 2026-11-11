package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
)

// Export returns every event of a session, in order. Children the session started are separate sessions and are
// not part of it.
func (m *Manager) Export(ctx context.Context, id event.ID) ([]event.Event, error) {
	stream := event.Stream("session:" + id)
	var facts []event.Event
	for from := uint64(1); ; {
		page, err := m.store.Read(ctx, stream, from, 256)
		if err != nil {
			return nil, err
		}
		facts = append(facts, page...)
		if len(page) < 256 {
			break
		}
		from = page[len(page)-1].Seq + 1
	}
	if len(facts) == 0 {
		return nil, errors.New("session not found")
	}
	return facts, nil
}

// Import adds the events of an exported session as a session of its own, under a new id and with new event ids.
// It returns the new id. Records of the workspace files (snapshots) are not carried over: the copy keeps what was
// said, not the means to put files back.
func (m *Manager) Import(ctx context.Context, facts []event.Event, newID func() event.ID) (event.ID, error) {
	id := newID()
	retargeted, err := retarget(facts, id, newID)
	if err != nil {
		return "", err
	}
	for _, fact := range retargeted {
		if err := m.bus.Import(ctx, fact); err != nil {
			return "", err
		}
	}
	state, err := m.Load(ctx, id)
	if err != nil {
		return "", err
	}
	if err := m.Snapshot(ctx, state); err != nil {
		return "", err
	}
	return id, nil
}

func retarget(facts []event.Event, id event.ID, newID func() event.ID) ([]event.Event, error) {
	if len(facts) == 0 || facts[0].Type != Created {
		return nil, errors.New("an exported session starts with session.created")
	}
	created, err := event.Decode[State](facts[0])
	if err != nil || created.ID == "" {
		return nil, errors.New("invalid session.created")
	}
	old := created.ID
	stream := event.Stream("session:" + old)
	ids := make(map[event.ID]event.ID, len(facts))
	for _, fact := range facts {
		if fact.Stream != stream || fact.Scope.Session != old || fact.Scope.Group != "" {
			return nil, errors.New("these events are not the events of one conversation")
		}
		ids[fact.ID] = newID()
	}
	var result []event.Event
	for _, fact := range facts {
		if fact.Type == Tracked {
			continue
		}
		fact.ID, fact.Stream = ids[fact.ID], event.Stream("session:"+id)
		fact.Seq = uint64(len(result) + 1)
		fact.Scope.Session = id
		if turn, ok := ids[fact.Scope.Turn]; ok {
			fact.Scope.Turn = turn
		}
		fact.Cause = ids[fact.Cause]
		switch fact.Type {
		case Created:
			created.ID, created.Scope.Session = id, id
			if fact.Payload, err = json.Marshal(created); err != nil {
				return nil, err
			}
		case Reverted:
			revert, err := event.Decode[Revert](fact)
			if err != nil {
				return nil, err
			}
			revert.Message, revert.Current, revert.Restored = ids[revert.Message], "", ""
			if fact.Payload, err = json.Marshal(revert); err != nil {
				return nil, err
			}
		}
		result = append(result, fact)
	}
	return result, nil
}
