package worker

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// RecoverInput includes durable inputs until the product acknowledges them.
func RecoverInput(ctx context.Context, storage store.Store, id event.ID, fresh bool, history []model.Message, text string) (string, []event.ID, error) {
	if storage == nil {
		return text, nil, nil
	}
	facts, err := PendingInputs(ctx, storage, id)
	if err != nil {
		return "", nil, err
	}
	var pending []model.Message
	var ids []event.ID
	for _, fact := range facts {
		message, err := event.Decode[model.Message](fact)
		if err != nil {
			return "", nil, err
		}
		pending = append(pending, message)
		ids = append(ids, fact.ID)
	}
	if fresh && len(history) > 0 {
		pending = history
	}
	if len(pending) == 0 {
		return text, ids, nil
	}
	body, err := json.Marshal(pending)
	if err != nil {
		return "", nil, err
	}
	if len(body)+len(text) > 4<<20 {
		return "", nil, errors.New("worker recovery input exceeds the replay limit")
	}
	return "Recovered engine conversation (JSON). Some inputs were not acknowledged before the interruption. Check the current state before retrying actions.\n" + string(body) + "\n\nCurrent instruction:\n" + text, ids, nil
}

func PendingInputs(ctx context.Context, storage store.Store, id event.ID) ([]event.Event, error) {
	if storage == nil {
		return nil, nil
	}
	acknowledgements, err := storage.List(ctx, "worker-input-ack", string(id)+":")
	if err != nil {
		return nil, err
	}
	accepted := make(map[string]bool)
	for _, doc := range acknowledgements {
		accepted[doc.Key] = true
	}
	facts, err := storage.Read(ctx, event.Stream("session:"+id), 1, 0)
	if err != nil {
		return nil, err
	}
	var pending []event.Event
	for _, fact := range facts {
		if fact.Type != session.MessageSent || accepted[string(id)+":"+string(fact.ID)] {
			continue
		}
		pending = append(pending, fact)
	}
	return pending, nil
}

func AcknowledgeInputs(ctx context.Context, storage store.Store, sessionID event.ID, ids []event.ID) error {
	if storage == nil {
		return nil
	}
	for _, id := range ids {
		err := storage.Put(ctx, store.Doc{Kind: "worker-input-ack", Key: string(sessionID) + ":" + string(id), Body: json.RawMessage(`{}`)})
		if err != nil && !errors.Is(err, store.ErrConflict) {
			return err
		}
	}
	return nil
}
