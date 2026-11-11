package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// List returns the notes of the given owners, newest first. Without owners it returns every note.
func (r *Repository) List(ctx context.Context, owners []Owner) ([]Note, error) {
	var keys []string
	if len(owners) == 0 {
		metas, err := r.store.List(ctx, "memory", "")
		if err != nil {
			return nil, err
		}
		for _, meta := range metas {
			keys = append(keys, meta.Key)
		}
	}
	for _, owner := range owners {
		if owner.ID == "" {
			continue
		}
		metas, err := r.store.List(ctx, "memory", prefix(owner))
		if err != nil {
			return nil, err
		}
		for _, meta := range metas {
			keys = append(keys, meta.Key)
		}
	}
	notes := []Note{}
	seen := make(map[string]bool)
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		doc, err := r.store.Fetch(ctx, "memory", key)
		if err != nil {
			return nil, err
		}
		var note Note
		if json.Unmarshal(doc.Body, &note) == nil {
			notes = append(notes, note)
		}
	}
	slices.SortFunc(notes, func(a, b Note) int {
		if order := b.Created.Compare(a.Created); order != 0 {
			return order
		}
		return strings.Compare(string(a.ID), string(b.ID))
	})
	return notes, nil
}

// keyOf finds the document key of a note by its id.
func (r *Repository) keyOf(ctx context.Context, id event.ID) (string, error) {
	metas, err := r.store.List(ctx, "memory", "")
	if err != nil {
		return "", err
	}
	suffix := "/" + url.PathEscape(string(id))
	for _, meta := range metas {
		if strings.HasSuffix(meta.Key, suffix) {
			return meta.Key, nil
		}
	}
	return "", store.ErrNotFound
}

// Read returns one note by its id.
func (r *Repository) Read(ctx context.Context, id event.ID) (Note, error) {
	if id == "" {
		return Note{}, store.ErrNotFound
	}
	key, err := r.keyOf(ctx, id)
	if err != nil {
		return Note{}, err
	}
	doc, err := r.store.Fetch(ctx, "memory", key)
	if err != nil {
		return Note{}, err
	}
	var note Note
	if err := json.Unmarshal(doc.Body, &note); err != nil {
		return Note{}, errors.New("memory note is damaged")
	}
	return note, nil
}

// Delete removes one note by its id; the store keeps no deleted notes.
func (r *Repository) Delete(ctx context.Context, id event.ID) error {
	if id == "" {
		return store.ErrNotFound
	}
	key, err := r.keyOf(ctx, id)
	if err != nil {
		return err
	}
	return r.store.Delete(ctx, "memory", key)
}
