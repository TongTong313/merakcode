package catalog

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
)

const publicProvider = "public"

// Snapshot is what is kept between runs for one list: a provider's own, or the public catalog.
type Snapshot struct {
	Fetched time.Time  `json:"fetched"`
	Models  []Override `json:"models"`
}

// Cache keeps snapshots across runs, so that the lists are there at startup and offline.
type Cache interface {
	// Load returns every snapshot, by provider id and "public".
	Load(ctx context.Context) (map[string]Snapshot, error)
	Save(ctx context.Context, key string, snapshot Snapshot) error
}

// Hooks connect a catalog to its surroundings.
type Hooks struct {
	Cache Cache
	// Notify is told after every fetch: err is nil when the list was refreshed. The provider is "public" for the
	// public catalog.
	Notify func(provider string, err error)
	Now    func() time.Time
	// Interval is the time between two checks for stale lists, and MaxAge how old a list may get; both default to an hour.
	Interval, MaxAge time.Duration
	// Disabled stops the background fetches; a refresh asked for by name still goes through.
	Disabled bool
}

type background struct {
	hooks   Hooks
	fetched map[string]time.Time
	// tried is when a list was last asked for, so that a failing one is retried after MaxAge, not at every wake-up.
	tried map[string]time.Time
	force map[string]bool
	sigs  map[string]string
	wake  chan struct{}
}

func (c *Catalog) now() time.Time {
	if c.state.hooks.Now != nil {
		return c.state.hooks.Now()
	}
	return time.Now()
}

func (c *Catalog) report(provider string, err error) {
	if c.state.hooks.Notify != nil {
		c.state.hooks.Notify(provider, err)
	}
}

func (c *Catalog) save(ctx context.Context, key string, snapshot Snapshot) {
	if c.state.hooks.Cache != nil {
		_ = c.state.hooks.Cache.Save(ctx, key, snapshot)
	}
}

// Attach reads the cache into the catalog. Call it before Run.
func (c *Catalog) Attach(ctx context.Context, hooks Hooks) error {
	if hooks.Interval <= 0 {
		hooks.Interval = time.Hour
	}
	if hooks.MaxAge <= 0 {
		hooks.MaxAge = time.Hour
	}
	c.mu.Lock()
	c.state.hooks = hooks
	c.mu.Unlock()
	if hooks.Cache == nil {
		return nil
	}
	snapshots, err := hooks.Cache.Load(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, snapshot := range snapshots {
		if key == publicProvider {
			c.setPublic(snapshot.Models)
			c.state.fetched[key] = snapshot.Fetched
			continue
		}
		c.setLive(key, snapshot.Models, snapshot.Fetched)
	}
	return nil
}

func signature(source Source) string {
	names := slices.Sorted(maps.Keys(source.Headers))
	var headers strings.Builder
	for _, name := range names {
		headers.WriteString(name + "=" + source.Headers[name] + "\n")
	}
	return fmt.Sprint(source.BaseURL, "|", source.APIKey, "|", source.Protocol, "|", source.Auth, "|", source.Disabled, "|", headers.String())
}

// ConfigureSources sets the providers whose lists are fetched. A provider whose address, key or headers changed is
// refreshed right away; the others when their list is stale.
func (c *Catalog) ConfigureSources(sources []Source) {
	c.mu.Lock()
	c.configuredSources = slices.Clone(sources)
	for index := range c.configuredSources {
		c.configuredSources[index].Headers = maps.Clone(sources[index].Headers)
	}
	previous := c.state.sigs
	c.state.sigs = make(map[string]string, len(sources))
	for _, source := range sources {
		sig := signature(source)
		c.state.sigs[source.Provider] = sig
		if old, known := previous[source.Provider]; known && old != sig {
			c.state.force[source.Provider] = true
		}
	}
	c.mu.Unlock()
	select {
	case c.state.wake <- struct{}{}:
	default:
	}
}

// Run fetches stale lists in the background until ctx ends: now, when sources change, and every interval.
func (c *Catalog) Run(ctx context.Context) {
	for {
		c.refreshDue(ctx)
		c.mu.RLock()
		interval := c.state.hooks.Interval
		c.mu.RUnlock()
		select {
		case <-ctx.Done():
			return
		case <-c.state.wake:
		case <-time.After(interval):
		}
	}
}

func (c *Catalog) refreshDue(ctx context.Context) {
	c.mu.RLock()
	disabled, maxAge := c.state.hooks.Disabled, c.state.hooks.MaxAge
	c.mu.RUnlock()
	if disabled {
		return
	}
	sources := c.allSources()
	due := func(key string) bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		forced := c.state.force[key]
		delete(c.state.force, key)
		last, ok := c.state.fetched[key]
		if tried := c.state.tried[key]; tried.After(last) {
			last = tried
		}
		if forced || !ok && c.state.tried[key].IsZero() || c.now().Sub(last) >= maxAge {
			c.state.tried[key] = c.now()
			return true
		}
		return false
	}
	done := make(chan struct{})
	pending := 0
	run := func(work func()) {
		pending++
		go func() {
			defer func() { done <- struct{}{} }()
			work()
		}()
	}
	active := 0
	for _, source := range sources {
		if source.Disabled {
			continue
		}
		active++
		if due(source.Provider) {
			run(func() { _ = c.refreshSource(ctx, source) })
		}
	}
	if active > 0 && due(publicProvider) {
		run(func() { _ = c.refreshPublic(ctx) })
	}
	for ; pending > 0; pending-- {
		<-done
	}
}

func (c *Catalog) refreshPublic(ctx context.Context) error {
	c.mu.RLock()
	address := c.publicURL
	c.mu.RUnlock()
	entries, err := fetchPublic(ctx, address)
	if err != nil {
		c.report(publicProvider, err)
		return err
	}
	now := c.now()
	c.mu.Lock()
	c.setPublic(entries)
	c.state.fetched[publicProvider] = now
	c.mu.Unlock()
	c.save(ctx, publicProvider, Snapshot{Fetched: now, Models: entries})
	c.report(publicProvider, nil)
	return nil
}
