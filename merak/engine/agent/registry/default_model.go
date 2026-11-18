package registry

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
)

// SetDefaultModel sets the model that members without a model of their own use.
func (e *Registry) SetDefaultModel(provider, name string, thinking model.Thinking) {
	e.defaultModel.Store(&definition.ModelRef{Provider: provider, Model: name, Thinking: thinking})
}

// MemberModel returns the member's own model, or the default model when the profile names none.
func (e *Registry) MemberModel(ref definition.ModelRef) (definition.ModelRef, error) {
	if ref.Provider != "" {
		return ref, nil
	}
	fallback := e.defaultModel.Load()
	if fallback == nil || fallback.Provider == "" {
		return definition.ModelRef{}, errorcode.Coded(errorcode.ModelRequestFailed, errors.New("no model is configured for this member and there is no default model"))
	}
	return *fallback, nil
}

// SetSmallModel sets the model for small jobs such as naming a conversation; without one those jobs use the
// default model, and without that they are skipped.
func (e *Registry) SetSmallModel(provider, name string) {
	e.smallModel.Store(&definition.ModelRef{Provider: provider, Model: name})
}

func (e *Registry) smallJobModel() (definition.ModelRef, bool) {
	for _, ref := range []*definition.ModelRef{e.smallModel.Load(), e.defaultModel.Load()} {
		if ref != nil && ref.Provider != "" && ref.Model != "" {
			return *ref, true
		}
	}
	return definition.ModelRef{}, false
}

// CompleteText asks a model one question and returns its text; it is for short jobs such as a title or a
// commit message.
func (e *Registry) CompleteText(ctx context.Context, ref definition.ModelRef, system, prompt string, maxTokens int) (string, error) {
	provider := e.Provider(ref.Provider)
	if provider == nil {
		return "", errorcode.Coded(errorcode.ModelRequestFailed, errors.New("the model's provider is not configured"))
	}
	stream, err := provider.Stream(ctx, model.Request{Model: ref.Model, MaxTokens: maxTokens, System: system, Messages: []model.Message{{Role: model.User, Parts: []model.Part{{Text: prompt}}}}})
	if err != nil {
		return "", err
	}
	defer stream.Close()
	var collector model.Collector
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		collector.Add(chunk)
	}
	message, _, _ := collector.Message()
	var text strings.Builder
	for _, part := range message.Parts {
		text.WriteString(part.Text)
	}
	return text.String(), nil
}
