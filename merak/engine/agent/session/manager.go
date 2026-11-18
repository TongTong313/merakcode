package session

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
)

type Manager struct {
	store store.Store
	bus   *event.Bus
	mu    sync.Mutex
	hot   map[event.ID]*State
}

func NewManager(storage store.Store, bus *event.Bus) *Manager {
	return &Manager{store: storage, bus: bus, hot: make(map[event.ID]*State)}
}

func (m *Manager) Create(ctx context.Context, state State) (*State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if state.ID == "" {
		return nil, store.ErrNotFound
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	scope := state.Scope
	scope.Session = state.ID
	actor := event.Actor{Kind: event.ActorHuman}
	if state.Config.Member != "" {
		actor = event.Actor{Kind: event.ActorAgent, ID: state.Config.Member}
	}
	fact, err := m.bus.Publish(ctx, event.Event{Stream: event.Stream("session:" + state.ID), Scope: scope, Type: Created, Actor: actor, Payload: payload})
	if err != nil {
		return nil, err
	}
	if err := Fold(&state, fact); err != nil {
		return nil, err
	}
	state.guard = &stateGuard{}
	m.hot[state.ID] = &state
	return &state, nil
}

// Load returns the live session. Use State.Read to inspect a shared session and
// State.Publish to apply events while the session is running.
func (m *Manager) Load(ctx context.Context, id event.ID) (*State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if state := m.hot[id]; state != nil {
		return state, nil
	}
	var state State
	doc, err := m.store.Fetch(ctx, "snapshot", string(id))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(doc.Body, &state); err != nil {
			return nil, err
		}
		if state.ID != id {
			return nil, store.ErrConflict
		}
	}
	stream := event.Stream("session:" + id)
	for {
		facts, err := m.store.Read(ctx, stream, state.LastSeq+1, 128)
		if err != nil {
			return nil, err
		}
		for _, fact := range facts {
			if fact.Seq != state.LastSeq+1 {
				return nil, store.ErrSequence
			}
			if err := Fold(&state, fact); err != nil {
				return nil, err
			}
		}
		if len(facts) < 128 {
			break
		}
	}
	if state.ID == "" {
		return nil, store.ErrNotFound
	}
	m.bus.Resume(stream, state.LastSeq)
	state.guard = &stateGuard{}
	m.hot[id] = &state
	return &state, nil
}

func (m *Manager) Snapshot(ctx context.Context, state *State) error {
	copy := state.Read()
	m.mu.Lock()
	live := m.hot[copy.ID]
	m.mu.Unlock()
	if live != nil {
		live.guard.save.Lock()
		defer live.guard.save.Unlock()
	}
	body, err := json.Marshal(copy)
	if err != nil {
		return err
	}
	doc, err := m.store.Fetch(ctx, "snapshot", string(copy.ID))
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil {
		var saved struct {
			LastSeq uint64 `json:"lastSeq"`
		}
		if err := json.Unmarshal(doc.Body, &saved); err != nil {
			return err
		}
		if saved.LastSeq > copy.LastSeq {
			return nil
		}
	}
	return m.store.Put(ctx, store.Doc{Kind: "snapshot", Key: string(copy.ID), Rev: doc.Rev, Body: body})
}

type Info struct {
	ID        event.ID  `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	Title     string    `json:"title,omitempty"`
	Archived  bool      `json:"archived,omitempty"`
	Config    Config    `json:"config"`
}

func (m *Manager) List(ctx context.Context) ([]Info, error) {
	facts, err := m.store.Find(ctx, store.Query{Types: []event.Type{Created, Updated}})
	if err != nil {
		return nil, err
	}
	result := []Info{}
	index := make(map[event.ID]int)
	for _, fact := range facts {
		if fact.Type == Updated {
			change, err := event.Decode[Change](fact)
			i, ok := index[fact.Scope.Session]
			if err != nil || !ok {
				continue
			}
			state := State{Title: result[i].Title, Archived: result[i].Archived, Config: result[i].Config}
			state.applyChange(change)
			result[i].Title, result[i].Archived, result[i].Config = state.Title, state.Archived, state.Config
			continue
		}
		state, err := event.Decode[State](fact)
		if err != nil {
			return nil, err
		}
		index[state.ID] = len(result)
		result = append(result, Info{ID: state.ID, CreatedAt: fact.Time, Title: state.Title, Archived: state.Archived, Config: state.Config})
	}
	return result, nil
}

// Delete removes a session and the children it started: their events, snapshots and hot state. It returns the
// ids it removed.
func (m *Manager) Delete(ctx context.Context, id event.ID) ([]event.ID, error) {
	infos, err := m.List(ctx)
	if err != nil {
		return nil, err
	}
	removed := []event.ID{id}
	for i := 0; i < len(removed); i++ {
		for _, info := range infos {
			if info.Config.Parent == removed[i] && !slices.Contains(removed, info.ID) {
				removed = append(removed, info.ID)
			}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, victim := range removed {
		if err := m.store.DeleteStream(ctx, event.Stream("session:"+victim)); err != nil {
			return nil, err
		}
		if err := m.store.Delete(ctx, "snapshot", string(victim)); err != nil {
			return nil, err
		}
		delete(m.hot, victim)
	}
	return removed, nil
}
