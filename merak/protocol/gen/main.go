// Command gen derives the protocol schema from Go wire types and registered event payloads.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/leader"
	"github.com/TongTong313/merakcode/merak/engine/model/catalog"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/terminal"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/git"
	"github.com/TongTong313/merakcode/merak/protocol"
)

type node map[string]any
type generator struct{ defs map[string]node }

func main() {
	g := generator{defs: make(map[string]node)}
	methods := map[string]node{}
	for _, method := range []struct {
		name           string
		params, result reflect.Type
	}{
		{"hello", reflect.TypeFor[protocol.HelloParams](), reflect.TypeFor[protocol.HelloResult]()},
		{"engine.stop", reflect.TypeFor[struct{}](), reflect.TypeFor[struct{}]()},
		{"config.get", reflect.TypeFor[struct{}](), reflect.TypeFor[protocol.Config]()},
		{"config.set", reflect.TypeFor[protocol.ConfigPatch](), reflect.TypeFor[protocol.Config]()},
		{"model.list", reflect.TypeFor[struct{}](), reflect.TypeFor[[]catalog.Model]()},
		{"member.catalog", reflect.TypeFor[struct{}](), reflect.TypeFor[[]worker.ProductInfo]()},
		{"member.register", reflect.TypeFor[protocol.MemberRegisterParams](), reflect.TypeFor[group.Member]()},
		{"member.test", reflect.TypeFor[protocol.ProfileSaveParams](), reflect.TypeFor[worker.Caps]()},
		{"profile.list", reflect.TypeFor[protocol.ProfileListParams](), reflect.TypeFor[[]profile.Profile]()},
		{"profile.save", reflect.TypeFor[protocol.ProfileSaveParams](), reflect.TypeFor[profile.Profile]()},
		{"group.create", reflect.TypeFor[protocol.GroupCreateParams](), reflect.TypeFor[group.Group]()},
		{"group.update", reflect.TypeFor[protocol.GroupUpdateParams](), reflect.TypeFor[group.Group]()},
		{"group.addMember", reflect.TypeFor[protocol.GroupAddMemberParams](), reflect.TypeFor[group.Member]()},
		{"group.state", reflect.TypeFor[protocol.GroupIDParams](), reflect.TypeFor[leader.View]()},
		{"task.create", reflect.TypeFor[protocol.TaskCreateParams](), reflect.TypeFor[task.Card]()},
		{"group.say", reflect.TypeFor[protocol.GroupSayParams](), reflect.TypeFor[event.ID]()},
		{"task.assign", reflect.TypeFor[protocol.TaskAssignParams](), reflect.TypeFor[task.Claim]()},
		{"task.review", reflect.TypeFor[protocol.TaskReviewParams](), reflect.TypeFor[struct{}]()},
		{"task.update", reflect.TypeFor[protocol.TaskUpdateParams](), reflect.TypeFor[task.Card]()},
		{"task.cancel", reflect.TypeFor[protocol.TaskCancelParams](), reflect.TypeFor[task.Card]()},
		{"model.refresh", reflect.TypeFor[protocol.ModelRefreshParams](), reflect.TypeFor[[]catalog.Model]()},
		{"model.discover", reflect.TypeFor[protocol.ModelDiscoverParams](), reflect.TypeFor[[]catalog.Model]()},
		{"diagnostics.bundle", reflect.TypeFor[protocol.DiagnosticsParams](), reflect.TypeFor[protocol.DiagnosticsResult]()},
		{"blob.read", reflect.TypeFor[protocol.BlobReadParams](), reflect.TypeFor[protocol.BlobReadResult]()},
		{"terminal.list", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]terminal.Info]()},
		{"terminal.create", reflect.TypeFor[terminal.CreateOptions](), reflect.TypeFor[terminal.Info]()},
		{"terminal.get", reflect.TypeFor[protocol.TerminalIDParams](), reflect.TypeFor[terminal.Info]()},
		{"terminal.update", reflect.TypeFor[protocol.TerminalUpdateParams](), reflect.TypeFor[terminal.Info]()},
		{"terminal.remove", reflect.TypeFor[protocol.TerminalIDParams](), reflect.TypeFor[struct{}]()},
		{"file.read", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[engine.FileContent]()},
		{"file.list", reflect.TypeFor[protocol.FileParams](), reflect.TypeFor[[]engine.FileNode]()},
		{"repo.status", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[git.State]()},
		{"repo.diff", reflect.TypeFor[protocol.RepoDiffParams](), reflect.TypeFor[[]git.Change]()},
		{"repo.branches", reflect.TypeFor[protocol.DirectoryParams](), reflect.TypeFor[[]git.Branch]()},
		{"repo.checkout", reflect.TypeFor[protocol.RepoCheckoutParams](), reflect.TypeFor[struct{}]()},
		{"session.create", reflect.TypeFor[protocol.SessionCreateParams](), reflect.TypeFor[protocol.SessionCreateResult]()},
		{"session.send", reflect.TypeFor[protocol.SessionSendParams](), reflect.TypeFor[struct{}]()},
		{"session.cancel", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[struct{}]()},
		{"session.list", reflect.TypeFor[struct{}](), reflect.TypeFor[[]session.Info]()},
		{"session.snapshot", reflect.TypeFor[protocol.SessionCancelParams](), reflect.TypeFor[session.State]()},
		{"events.read", reflect.TypeFor[protocol.EventsReadParams](), reflect.TypeFor[[]event.Event]()},
		{"events.find", reflect.TypeFor[store.Query](), reflect.TypeFor[[]event.Event]()},
		{"events.get", reflect.TypeFor[protocol.EventsGetParams](), reflect.TypeFor[event.Event]()},
		{"event.emit", reflect.TypeFor[protocol.EventEmitParams](), reflect.TypeFor[event.Event]()},
		{"permission.reply", reflect.TypeFor[protocol.PermissionReplyParams](), reflect.TypeFor[struct{}]()},
		{"question.reply", reflect.TypeFor[protocol.QuestionReplyParams](), reflect.TypeFor[struct{}]()},
		{"events.subscribe", reflect.TypeFor[event.Filter](), reflect.TypeFor[protocol.SubscribeResult]()},
		{"events.unsubscribe", reflect.TypeFor[protocol.UnsubscribeParams](), reflect.TypeFor[struct{}]()},
		{"store.append", reflect.TypeFor[protocol.StoreAppendParams](), reflect.TypeFor[struct{}]()},
		{"store.read", reflect.TypeFor[protocol.EventsReadParams](), reflect.TypeFor[[]event.Event]()},
		{"store.find", reflect.TypeFor[store.Query](), reflect.TypeFor[[]event.Event]()},
		{"store.get", reflect.TypeFor[protocol.EventsGetParams](), reflect.TypeFor[event.Event]()},
		{"store.put", reflect.TypeFor[protocol.StorePutParams](), reflect.TypeFor[struct{}]()},
		{"store.fetch", reflect.TypeFor[protocol.StoreFetchParams](), reflect.TypeFor[store.Doc]()},
		{"store.list", reflect.TypeFor[protocol.StoreListParams](), reflect.TypeFor[[]store.DocMeta]()},
	} {
		methods[method.name] = node{"params": g.describe(method.params), "result": g.describe(method.result)}
	}
	events := map[string]node{}
	for kind, t := range event.Payloads() {
		events[string(kind)] = g.describe(t)
	}
	envelope := g.describe(reflect.TypeFor[event.Event]())
	g.describe(reflect.TypeFor[protocol.Error]())
	g.describe(reflect.TypeFor[protocol.ConnectionInfo]())
	document := node{"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": g.defs, "x-protocol": protocol.Version, "x-methods": methods, "x-events": events, "x-envelope": envelope}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
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
		if !slices.Contains(tag, "omitempty") {
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
