package engine

import (
	"errors"

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
