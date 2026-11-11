package engine

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
)

// SetDefaultModel sets the model that members without a model of their own use.
func (e *Engine) SetDefaultModel(provider, name string, thinking model.Thinking) {
	e.defaultModel.Store(&agent.ModelRef{Provider: provider, Model: name, Thinking: thinking})
}

// memberModel returns the member's own model, or the default model when the profile names none.
func (e *Engine) memberModel(ref agent.ModelRef) (agent.ModelRef, error) {
	if ref.Provider != "" {
		return ref, nil
	}
	fallback := e.defaultModel.Load()
	if fallback == nil || fallback.Provider == "" {
		return agent.ModelRef{}, coded(errorcode.ModelRequestFailed, errors.New("no model is configured for this member and there is no default model"))
	}
	return *fallback, nil
}

// SetSmallModel sets the model for small jobs such as naming a conversation; without one those jobs use the
// default model, and without that they are skipped.
func (e *Engine) SetSmallModel(provider, name string) {
	e.smallModel.Store(&agent.ModelRef{Provider: provider, Model: name})
}

func (e *Engine) smallJobModel() (agent.ModelRef, bool) {
	for _, ref := range []*agent.ModelRef{e.smallModel.Load(), e.defaultModel.Load()} {
		if ref != nil && ref.Provider != "" && ref.Model != "" {
			return *ref, true
		}
	}
	return agent.ModelRef{}, false
}

// completeText asks a model one question and returns its text; it is for short jobs such as a title or a
// commit message.
func (e *Engine) completeText(ctx context.Context, ref agent.ModelRef, system, prompt string, maxTokens int) (string, error) {
	provider := e.provider(ref.Provider)
	if provider == nil {
		return "", coded(errorcode.ModelRequestFailed, errors.New("the model's provider is not configured"))
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
