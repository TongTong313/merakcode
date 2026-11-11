package session

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/store"
)

// Hit is a session that has a message containing the searched text.
type Hit struct {
	Session event.ID `json:"session"`
	Title   string   `json:"title,omitempty"`
	// Snippet is a piece of the matching message around the text.
	Snippet string `json:"snippet"`
}

const snippetRadius = 60

// Search finds the sessions with a message that contains text, newest match first, one hit per session.
func (m *Manager) Search(ctx context.Context, text string, limit int) ([]Hit, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return []Hit{}, nil
	}
	facts, err := m.store.Find(ctx, store.Query{Text: text, Types: []event.Type{MessageSent, MessageCompleted}})
	if err != nil {
		return nil, err
	}
	infos, err := m.List(ctx)
	if err != nil {
		return nil, err
	}
	titles := make(map[event.ID]string, len(infos))
	for _, info := range infos {
		titles[info.ID] = info.Title
	}
	hits := []Hit{}
	seen := make(map[event.ID]bool)
	for i := len(facts) - 1; i >= 0 && (limit <= 0 || len(hits) < limit); i-- {
		fact := facts[i]
		if !strings.HasPrefix(string(fact.Stream), "session:") || seen[fact.Scope.Session] {
			continue
		}
		message, err := event.Decode[Completion](fact)
		if err != nil {
			continue
		}
		var body strings.Builder
		for _, part := range message.Parts {
			body.WriteString(part.Text)
			body.WriteByte(' ')
		}
		snippet, ok := snippetAround(body.String(), text)
		if !ok {
			continue
		}
		seen[fact.Scope.Session] = true
		hits = append(hits, Hit{Session: fact.Scope.Session, Title: titles[fact.Scope.Session], Snippet: snippet})
	}
	return hits, nil
}

// snippetAround cuts a short piece of body around the first case-insensitive occurrence of text.
func snippetAround(body, text string) (string, bool) {
	at := strings.Index(strings.ToLower(body), strings.ToLower(text))
	if at < 0 || len(strings.ToLower(body)) != len(body) && !strings.Contains(body, text) {
		return "", false
	}
	runes := []rune(body)
	start := utf8.RuneCountInString(body[:at])
	end := start + utf8.RuneCountInString(text)
	from, to := max(0, start-snippetRadius), min(len(runes), end+snippetRadius)
	return strings.TrimSpace(string(runes[from:to])), true
}
