package log

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"slices"
	"strings"

	"github.com/TongTong313/merakcode/merak/internal/platform/secret"
)

type handler struct {
	output    io.Writer
	level     slog.Leveler
	component string
	attrs     []slog.Attr
	groups    []string
}

func (h *handler) Enabled(_ context.Context, level slog.Level) bool { return level >= h.level.Level() }

func (h *handler) Handle(ctx context.Context, record slog.Record) error {
	attrs := slices.Clone(h.attrs)
	var current []slog.Attr
	record.Attrs(func(attr slog.Attr) bool { current = append(current, attr); return true })
	attrs = append(attrs, wrapGroups(h.groups, current)...)
	keys := make(map[string]bool)
	for _, attr := range attrs {
		keys[attr.Key] = true
	}
	clean := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	for _, attr := range []slog.Attr{slog.String("component", h.component), slog.String("session", ""), slog.String("group", ""), slog.String("task", ""), slog.String("event", "")} {
		if !keys[attr.Key] {
			clean.AddAttrs(attr)
		}
	}
	clean.AddAttrs(attrs...)
	base := slog.NewJSONHandler(h.output, &slog.HandlerOptions{Level: h.level, ReplaceAttr: redactAttr})
	return base.Handle(ctx, clean)
}

func (h *handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	copy := *h
	copy.attrs = append(slices.Clone(h.attrs), wrapGroups(h.groups, attrs)...)
	return &copy
}

func (h *handler) WithGroup(name string) slog.Handler {
	copy := *h
	if name != "" {
		copy.groups = append(slices.Clone(h.groups), name)
	}
	return &copy
}

func wrapGroups(groups []string, attrs []slog.Attr) []slog.Attr {
	for i := len(groups) - 1; i >= 0; i-- {
		attrs = []slog.Attr{{Key: groups[i], Value: slog.GroupValue(attrs...)}}
	}
	return attrs
}

func redactAttr(groups []string, attr slog.Attr) slog.Attr {
	attr.Value = attr.Value.Resolve()
	for _, group := range groups {
		if secret.SensitiveKey(group) || conversationKey(group) {
			return slog.String(attr.Key, "[redacted]")
		}
	}
	if secret.SensitiveKey(attr.Key) {
		return slog.String(attr.Key, "[redacted]")
	}
	if conversationKey(attr.Key) {
		return slog.String(attr.Key, "[redacted]")
	}
	if attr.Value.Kind() == slog.KindString {
		return slog.String(attr.Key, secret.Redact(attr.Value.String()))
	}
	if attr.Value.Kind() == slog.KindAny {
		body, err := json.Marshal(attr.Value.Any())
		if err != nil {
			return slog.String(attr.Key, "[redacted]")
		}
		var value any
		if json.Unmarshal(body, &value) != nil {
			return slog.String(attr.Key, "[redacted]")
		}
		return slog.Any(attr.Key, redactContent(secret.RedactValue(value)))
	}
	return attr
}

func conversationKey(key string) bool {
	switch strings.ToLower(key) {
	case "prompt", "content", "messages", "input", "output", "body":
		return true
	}
	return false
}

func redactContent(value any) any {
	switch value := value.(type) {
	case map[string]any:
		for key, item := range value {
			if conversationKey(key) {
				value[key] = "[redacted]"
			} else {
				value[key] = redactContent(item)
			}
		}
	case []any:
		for i, item := range value {
			value[i] = redactContent(item)
		}
	}
	return value
}

func SanitizeRecord(data []byte) ([]byte, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return json.Marshal(redactContent(secret.RedactValue(value)))
}
