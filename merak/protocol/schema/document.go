package schema

import (
	"encoding/json"
	"io"
	"path"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type node map[string]any
type generator struct{ defs map[string]node }

// WriteDocument writes the JSON Schema of the protocol: its methods with their parameters and results, the typed
// payload of every registered event and the event envelope.
func WriteDocument(output io.Writer) error {
	g := generator{defs: make(map[string]node)}
	methods := map[string]node{}
	for _, method := range Methods() {
		methods[method.Name] = node{"params": g.describe(method.Params), "result": g.describe(method.Result)}
	}
	events := map[string]node{}
	for kind, t := range event.Payloads() {
		events[string(kind)] = g.describe(t)
	}
	envelope := g.describe(reflect.TypeFor[event.Event]())
	g.describe(reflect.TypeFor[protocol.Error]())
	g.describe(reflect.TypeFor[protocol.ConnectionInfo]())
	document := node{"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": g.defs, "x-protocol": protocol.Version, "x-methods": methods, "x-events": events, "x-envelope": envelope}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(document)
}

func (g *generator) describe(t reflect.Type) node {
	if t == reflect.TypeFor[json.RawMessage]() {
		return node{}
	}
	if t == reflect.TypeFor[[]byte]() {
		return node{"anyOf": []node{{"type": "string"}, {"type": "null"}}}
	}
	if t == reflect.TypeFor[time.Time]() {
		return node{"type": "string", "format": "date-time"}
	}
	if t.Kind() == reflect.Pointer {
		return node{"anyOf": []node{g.describe(t.Elem()), {"type": "null"}}}
	}
	if t.Kind() == reflect.Struct && t.Name() != "" {
		pkg := path.Base(t.PkgPath())
		name := strings.ToUpper(pkg[:1]) + pkg[1:] + t.Name()
		if _, exists := g.defs[name]; !exists {
			g.defs[name] = node{}
			g.defs[name] = g.object(t)
		}
		return node{"$ref": "#/$defs/" + name}
	}
	switch t.Kind() {
	case reflect.Struct:
		return g.object(t)
	case reflect.String:
		return node{"type": "string"}
	case reflect.Bool:
		return node{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return node{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return node{"type": "number"}
	case reflect.Slice:
		return node{"anyOf": []node{{"type": "array", "items": g.describe(t.Elem())}, {"type": "null"}}}
	case reflect.Map:
		return node{"type": "object", "additionalProperties": g.describe(t.Elem())}
	default:
		panic("protocol: unsupported wire type " + t.String())
	}
}

func (g *generator) object(t reflect.Type) node {
	properties := map[string]node{}
	var required []string
	for i := 0; i < t.NumField(); i++ {
		field := t.Field(i)
		if !field.IsExported() {
			continue
		}
		tag := strings.Split(field.Tag.Get("json"), ",")
		if tag[0] == "-" {
			continue
		}
		if field.Anonymous && tag[0] == "" {
			embedded := g.object(field.Type)
			for key, value := range embedded["properties"].(map[string]node) {
				properties[key] = value
			}
			if fields, ok := embedded["required"].([]string); ok {
				required = append(required, fields...)
			}
			continue
		}
		name := tag[0]
		if name == "" {
			name = field.Name
		}
		properties[name] = g.describe(field.Type)
		if !slices.Contains(tag, "omitempty") && !slices.Contains(tag, "omitzero") {
			required = append(required, name)
		}
	}
	slices.Sort(required)
	result := node{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}
