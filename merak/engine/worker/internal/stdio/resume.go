package stdio

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type productSession struct {
	Kind, Product, Directory string
	Scope                    event.Scope
	Member                   event.ID
}

func LoadSession(ctx context.Context, storage store.Store, a worker.Assignment, kind string) (string, error) {
	if storage == nil {
		return "", nil
	}
	doc, err := storage.Fetch(ctx, "worker-session", string(a.Session))
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var value productSession
	if err := json.Unmarshal(doc.Body, &value); err != nil {
		return "", err
	}
	if value.Kind != kind || value.Directory != a.Workdir || value.Scope != a.Scope || value.Member != a.Claim.Member {
		return "", errors.New("assignment does not match the product session")
	}
	return value.Product, nil
}
func SaveSession(ctx context.Context, storage store.Store, a worker.Assignment, kind, id string) error {
	if storage == nil {
		return nil
	}
	prior, err := LoadSession(ctx, storage, a, kind)
	if err != nil {
		return err
	}
	if prior != "" {
		if prior != id {
			return errors.New("product resumed a different session")
		}
		return nil
	}
	body, err := json.Marshal(productSession{Kind: kind, Product: id, Directory: a.Workdir, Scope: a.Scope, Member: a.Claim.Member})
	if err != nil {
		return err
	}
	return storage.Put(ctx, store.Doc{Kind: "worker-session", Key: string(a.Session), Body: body})
}
