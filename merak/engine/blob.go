package engine

import (
	"context"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

func (e *Engine) PutBlob(ctx context.Context, name string, data []byte) (string, error) {
	ref, err := e.spill(ctx, name, data)
	return string(ref), err
}

func (e *Engine) ReadBlob(ctx context.Context, ref string, offset, limit int) ([]byte, int, error) {
	key, ok := strings.CutPrefix(ref, "mrk://blob/")
	if !ok || key == "" || strings.ContainsAny(key, "/\\?#") || offset < 0 || limit < 0 || limit > 1<<20 {
		return nil, 0, errors.New("invalid blob read")
	}
	if limit == 0 {
		limit = 1 << 20
	}
	doc, err := e.store.Fetch(ctx, "blob", key)
	if err != nil {
		return nil, 0, err
	}
	if offset > len(doc.Body) {
		return nil, 0, store.ErrNotFound
	}
	return doc.Body[offset:min(offset+limit, len(doc.Body))], len(doc.Body), nil
}

func (e *Engine) ModelCatalog(overrides ...catalog.Override) []catalog.Model {
	return e.catalog.List(overrides...)
}

// blobs makes a provider read the images that messages keep as blob references.
func (e *Engine) blobs(p model.Provider) model.Provider {
	return model.Blobs{Provider: p, Read: func(ctx context.Context, key string) ([]byte, error) {
		doc, err := e.store.Fetch(ctx, "blob", key)
		return doc.Body, err
	}}
}
