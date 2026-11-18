package tool

import (
	"maps"
	"sort"
	"sync"
)

type Pool struct {
	Name     string
	Tools    map[string]Tool
	Deferred map[string]Tool
	mu       sync.Mutex
	loaded   map[string]bool
}

func NewPool(name string, tools ...Tool) *Pool { return (&Pool{Name: name}).With(tools...) }

func (p *Pool) Specs() []Spec {
	if p == nil {
		return nil
	}
	var specs []Spec
	for _, t := range p.Tools {
		specs = append(specs, t.Spec())
	}
	if len(p.Deferred) > 0 {
		specs = append(specs, (loadTools{pool: p}).Spec(), (callTool{pool: p}).Spec())
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return specs
}

func (p *Pool) Lookup(name string) (Tool, bool) {
	if p == nil {
		return nil, false
	}
	if len(p.Deferred) > 0 {
		switch name {
		case "load_tools":
			return loadTools{pool: p}, true
		case "call_tool":
			return callTool{pool: p}, true
		}
	}
	t, ok := p.Tools[name]
	return t, ok
}

func (p *Pool) With(tools ...Tool) *Pool {
	copy := &Pool{Name: p.Name, Tools: maps.Clone(p.Tools), Deferred: maps.Clone(p.Deferred)}
	if copy.Tools == nil {
		copy.Tools = make(map[string]Tool)
	}
	for _, t := range tools {
		copy.Tools[t.Spec().Name] = t
	}
	return copy
}

// RestoreLoaded reinstates deferred names recorded by a recovered session.
func (p *Pool) RestoreLoaded(names []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loaded = make(map[string]bool, len(names))
	for _, name := range names {
		p.loaded[name] = true
	}
}

func (p *Pool) DeferredSpecs() []Spec {
	if p == nil {
		return nil
	}
	var specs []Spec
	for _, t := range p.Deferred {
		spec := t.Spec()
		specs = append(specs, Spec{Name: spec.Name, Description: spec.Description})
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Name < specs[j].Name })
	return specs
}
