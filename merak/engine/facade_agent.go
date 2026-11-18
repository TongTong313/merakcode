package engine

import (
	"context"

	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/agent/registry"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/feature/sessions"
	"github.com/TongTong313/merakcode/merak/engine/infra/config"
	"github.com/TongTong313/merakcode/merak/engine/infra/credential"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
)

func (e *Engine) ListAgents(ctx context.Context, human event.ID) ([]definition.Agent, error) {
	return e.registry.ListAgents(ctx, human)
}

func (e *Engine) ListAgentsFor(ctx context.Context, human event.ID, directory string) ([]definition.Agent, error) {
	return e.registry.ListAgentsFor(ctx, human, directory)
}

func (e *Engine) ConfigureAgents(settings registry.AgentSettings) {
	e.registry.ConfigureAgents(settings)
}

func (e *Engine) ModelCatalog(overrides ...catalog.Override) []catalog.Model {
	return e.registry.ModelCatalog(overrides...)
}

func (e *Engine) ConfigureNetworkSettings(settings registry.NetworkSettings) {
	e.registry.ConfigureNetworkSettings(settings)
}

func (e *Engine) SetProvider(name string, provider model.Provider) {
	e.registry.SetProvider(name, provider)
}

func (e *Engine) ConfigureModels(overrides []catalog.Override) { e.registry.ConfigureModels(overrides) }

func (e *Engine) RefreshModels(ctx context.Context, provider string) error {
	return e.registry.RefreshModels(ctx, provider)
}

func (e *Engine) Catalog() *catalog.Catalog { return e.registry.Catalog() }

func (e *Engine) ConfigureCatalog(sources []catalog.Source) { e.registry.ConfigureCatalog(sources) }

func (e *Engine) ConfigureTools(switches map[string]bool) { e.registry.ConfigureTools(switches) }

func (e *Engine) DiscoverModels(ctx context.Context, provider config.Provider) ([]catalog.Model, error) {
	return e.registry.DiscoverModels(ctx, provider)
}

func (e *Engine) SetDefaultModel(provider, name string, thinking model.Thinking) {
	e.registry.SetDefaultModel(provider, name, thinking)
}

func (e *Engine) SetSmallModel(provider, name string) { e.registry.SetSmallModel(provider, name) }

func (e *Engine) Directory(directory string) string { return e.registry.Directory(directory) }

func (e *Engine) ConfigureRules(personal []string) { e.registry.ConfigureRules(personal) }

func (e *Engine) ConfigureSkills(global string, extra, urls []string) {
	e.registry.ConfigureSkills(global, extra, urls)
}

// ConfigureSessions applies SessionSettings; it takes effect on the next turn.
func (e *Engine) ConfigureSessions(settings sessions.SessionSettings) {
	e.sessions.SetSnapshots(settings.Snapshot)
	e.conversation.SetAutoCompact(settings.AutoCompact)
	e.sessions.SetRetentionDays(settings.RetentionDays)
}

func (e *Engine) PutBlob(ctx context.Context, name string, data []byte) (string, error) {
	return e.conversation.PutBlob(ctx, name, data)
}

func (e *Engine) ReadBlob(ctx context.Context, ref string, offset, limit int) ([]byte, int, error) {
	return e.conversation.ReadBlob(ctx, ref, offset, limit)
}

func (e *Engine) CreateSession(ctx context.Context, options conversation.SessionOptions) (event.ID, error) {
	return e.conversation.CreateSession(ctx, options)
}

func (e *Engine) Cancel(id event.ID) error { return e.conversation.Cancel(id) }

func (e *Engine) Send(ctx context.Context, id event.ID, parts []model.Part, selections ...session.Selection) error {
	return e.conversation.Send(ctx, id, parts, selections...)
}

func (e *Engine) SendWithBudget(ctx context.Context, id event.ID, parts []model.Part, extendBudget bool, selections ...session.Selection) error {
	return e.conversation.SendWithBudget(ctx, id, parts, extendBudget, selections...)
}

func (e *Engine) UpdateSession(ctx context.Context, id event.ID, update session.Update) error {
	return e.conversation.UpdateSession(ctx, id, update)
}

func (e *Engine) CompactSession(ctx context.Context, id event.ID) error {
	return e.conversation.CompactSession(ctx, id)
}

func (e *Engine) DeleteSession(ctx context.Context, id event.ID) error {
	return e.conversation.DeleteSession(ctx, id)
}

func (e *Engine) SetLocalHuman(human event.ID) { e.conversation.SetLocalHuman(human) }

func (e *Engine) ReadEvents(ctx context.Context, stream event.Stream, from uint64, limit int) ([]event.Event, error) {
	return e.conversation.ReadEvents(ctx, stream, from, limit)
}

func (e *Engine) GetEvent(ctx context.Context, id event.ID) (event.Event, error) {
	return e.conversation.GetEvent(ctx, id)
}

func (e *Engine) ListSessions(ctx context.Context) ([]session.Info, error) {
	return e.conversation.ListSessions(ctx)
}

func (e *Engine) SessionSnapshot(ctx context.Context, id event.ID) (session.State, error) {
	return e.conversation.SessionSnapshot(ctx, id)
}

func (e *Engine) SearchSessions(ctx context.Context, text string, limit int) ([]session.Hit, error) {
	return e.conversation.SearchSessions(ctx, text, limit)
}

func (e *Engine) ConfigureMemory(settings conversation.MemorySettings) {
	e.conversation.ConfigureMemory(settings)
}

func (e *Engine) Chat(ctx context.Context, provider, input string) (loop.Outcome, error) {
	return e.conversation.Chat(ctx, provider, input)
}

// Vault returns the vault of the engine, for the server that hosts it.
func (e *Engine) Vault() credential.Vault { return e.registry.Vault() }

func (e *Engine) Subscribe(filter event.Filter) (<-chan event.Event, func()) {
	return e.core.Bus.Subscribe(filter)
}

func (e *Engine) ImportEvent(ctx context.Context, fact event.Event) error {
	return e.core.Bus.Import(ctx, fact)
}

func (e *Engine) Publish(ctx context.Context, fact event.Event) (event.Event, error) {
	return e.core.Bus.Publish(ctx, fact)
}
