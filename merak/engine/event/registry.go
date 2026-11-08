package event

import (
	"maps"
	"reflect"
	"sync"
)

var registry = struct {
	sync.RWMutex
	types map[Type]reflect.Type
}{types: make(map[Type]reflect.Type)}

func Register[T any](kind Type) {
	registry.Lock()
	defer registry.Unlock()
	if _, exists := registry.types[kind]; exists {
		panic("event: duplicate payload registration")
	}
	registry.types[kind] = reflect.TypeFor[T]()
}

func Payloads() map[Type]reflect.Type {
	registry.RLock()
	defer registry.RUnlock()
	return maps.Clone(registry.types)
}

func init() { Register[struct{}](Lagged) }
