package conversation

import (
	"context"
	"errors"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

func (domain *Manager) PutBlob(ctx context.Context, name string, data []byte) (string, error) {
	ref, err := domain.spill(ctx, name, data)
	return string(ref), err
}

func (domain *Manager) ReadBlob(ctx context.Context, ref string, offset, limit int) ([]byte, int, error) {
	key, ok := strings.CutPrefix(ref, "mrk://blob/")
	if !ok || key == "" || strings.ContainsAny(key, "/\\?#") || offset < 0 || limit < 0 || limit > 1<<20 {
		return nil, 0, errors.New("invalid blob read")
	}
	if limit == 0 {
		limit = 1 << 20
	}
	doc, err := domain.core.Store.Fetch(ctx, "blob", key)
	if err != nil {
		return nil, 0, err
	}
	if offset > len(doc.Body) {
		return nil, 0, store.ErrNotFound
	}
	return doc.Body[offset:min(offset+limit, len(doc.Body))], len(doc.Body), nil
}
