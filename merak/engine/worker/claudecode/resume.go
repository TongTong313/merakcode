package claudecode

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

type productSession struct {
	Product   string      `json:"product"`
	Directory string      `json:"directory"`
	Scope     event.Scope `json:"scope"`
	Member    event.ID    `json:"member"`
}

func (r *Runner) loadSession(ctx context.Context, a worker.Assignment) (productSession, error) {
	if r.Store == nil {
		return productSession{}, nil
	}
	doc, err := r.Store.Fetch(ctx, "worker-session", string(a.Session))
	if errors.Is(err, store.ErrNotFound) {
		return productSession{}, nil
	}
	if err != nil {
		return productSession{}, err
	}
	var previous productSession
	if err := json.Unmarshal(doc.Body, &previous); err != nil {
		return previous, err
	}
	if previous.Directory != a.Workdir || previous.Scope != a.Scope || previous.Member != a.Claim.Member {
		return previous, errors.New("assignment does not match the product session")
	}
	return previous, nil
}

func (r *Runner) saveSession(ctx context.Context, a worker.Assignment, id string, previous productSession) error {
	if r.Store == nil {
		return nil
	}
	if previous.Product != "" {
		if id != previous.Product {
			return errors.New("product resumed a different session")
		}
		return nil
	}
	body, err := json.Marshal(productSession{Product: id, Directory: a.Workdir, Scope: a.Scope, Member: a.Claim.Member})
	if err != nil {
		return err
	}
	return r.Store.Put(ctx, store.Doc{Kind: "worker-session", Key: string(a.Session), Body: body})
}
