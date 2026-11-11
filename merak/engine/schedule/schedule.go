package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

const (
	docKind   = "schedule"
	clockKind = "schedule-clock"
	clockKey  = "last"
)

// ErrNotFound is returned for a schedule that does not exist.
var ErrNotFound = errors.New("no such schedule")

// Schedule is one scheduled task: at the times Cron names, a conversation starts in Workdir and works on Prompt.
type Schedule struct {
	ID event.ID `json:"id"`
	// Cron is a five-field expression read in the machine's time zone.
	Cron   string `json:"cron"`
	Prompt string `json:"prompt"`
	// Agent names the agent that runs it; empty means the default.
	Agent   string `json:"agent,omitempty"`
	Workdir string `json:"workdir"`
	// Owner is the person the notices of its runs go to.
	Owner   event.ID  `json:"owner"`
	Created time.Time `json:"created"`
	// Next is when it runs next; it is filled in by List.
	Next time.Time `json:"next,omitzero"`
}

// Title is the name a conversation started by the schedule gets: a short form of the prompt after the label.
func (s Schedule) Title() string {
	line, _, _ := strings.Cut(strings.TrimSpace(s.Prompt), "\n")
	if runes := []rune(line); len(runes) > 40 {
		line = strings.TrimSpace(string(runes[:40])) + "…"
	}
	return "定时：" + line // i18n-allow
}

// Schedules stores the scheduled tasks as documents.
type Schedules struct{ Docs store.Store }

// Create checks and stores a schedule. The expression must parse, and the prompt and the folder must be given.
func (s Schedules) Create(ctx context.Context, value Schedule) (Schedule, error) {
	if _, err := Parse(value.Cron); err != nil {
		return Schedule{}, err
	}
	if value.ID == "" || strings.TrimSpace(value.Prompt) == "" || value.Workdir == "" {
		return Schedule{}, errors.New("a schedule needs an id, a prompt and a folder")
	}
	body, err := json.Marshal(value)
	if err != nil {
		return Schedule{}, err
	}
	return value, s.Docs.Put(ctx, store.Doc{Kind: docKind, Key: string(value.ID), Body: body, Meta: map[string]string{"owner": string(value.Owner)}})
}

// List returns the schedules, oldest first, each with the time it runs next.
func (s Schedules) List(ctx context.Context, now time.Time) ([]Schedule, error) {
	metas, err := s.Docs.List(ctx, docKind, "")
	if err != nil {
		return nil, err
	}
	found := make([]Schedule, 0, len(metas))
	for _, meta := range metas {
		value, err := s.Get(ctx, event.ID(meta.Key))
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if spec, err := Parse(value.Cron); err == nil {
			value.Next = spec.Next(now)
		}
		found = append(found, value)
	}
	slices.SortFunc(found, func(a, b Schedule) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(string(a.ID), string(b.ID))
	})
	return found, nil
}

// Get returns one schedule.
func (s Schedules) Get(ctx context.Context, id event.ID) (Schedule, error) {
	doc, err := s.Docs.Fetch(ctx, docKind, string(id))
	if errors.Is(err, store.ErrNotFound) {
		return Schedule{}, ErrNotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	var value Schedule
	return value, json.Unmarshal(doc.Body, &value)
}

// Delete removes a schedule; it never runs again.
func (s Schedules) Delete(ctx context.Context, id event.ID) error {
	if _, err := s.Get(ctx, id); err != nil {
		return err
	}
	return s.Docs.Delete(ctx, docKind, string(id))
}
