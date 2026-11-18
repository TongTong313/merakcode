package registry

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
)

func (e *Registry) ModelCatalog(overrides ...catalog.Override) []catalog.Model {
	return e.catalog.List(overrides...)
}

// blobs makes a provider read the images that messages keep as blob references.
func (e *Registry) blobs(p model.Provider) model.Provider {
	return model.Blobs{Provider: p, Read: func(ctx context.Context, key string) ([]byte, error) {
		doc, err := e.core.Store.Fetch(ctx, "blob", key)
		return doc.Body, err
	}}
}
