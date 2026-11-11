package catalog

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Refreshed and Failed report the outcome of fetching a provider's model list, or the public catalog (provider
// "public"). Clients read the model list again after the first and tell the user about the second.
const (
	Refreshed event.Type = "catalog.refreshed"
	Failed    event.Type = "catalog.failed"
)

// Notice is the payload of both events.
type Notice struct {
	Provider string `json:"provider"`
	Code     string `json:"code,omitempty"`
}

func init() {
	event.Register[Notice](Refreshed)
	event.Register[Notice](Failed)
}

// StoreCache keeps the fetched lists as documents of kind "catalog": one per provider and one for the public catalog.
type StoreCache struct{ Store store.Store }

func (c StoreCache) Load(ctx context.Context) (map[string]Snapshot, error) {
	metas, err := c.Store.List(ctx, "catalog", "")
	if err != nil {
		return nil, err
	}
	result := make(map[string]Snapshot, len(metas))
	for _, meta := range metas {
		doc, err := c.Store.Fetch(ctx, "catalog", meta.Key)
		if err != nil {
			return nil, err
		}
		var snapshot Snapshot
		if json.Unmarshal(doc.Body, &snapshot) == nil {
			result[meta.Key] = snapshot
		}
	}
	return result, nil
}

func (c StoreCache) Save(ctx context.Context, key string, snapshot Snapshot) error {
	body, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	doc, err := c.Store.Fetch(ctx, "catalog", key)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	return c.Store.Put(ctx, store.Doc{Kind: "catalog", Key: key, Rev: doc.Rev, Body: body})
}
