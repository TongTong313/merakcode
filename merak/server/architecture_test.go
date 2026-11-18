package server

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

const engineImport = "github.com/TongTong313/merakcode/merak/engine"

func TestServerUsesTheEngineFacade(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	parsed := map[string]*ast.File{}
	objects := serverObjects{types: map[any]string{}, fields: map[string]map[string]string{}}
	functions := map[string]map[string]bool{}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		parsed[name] = file
		declared := engineObjectNames(file)
		for declaration, name := range declared.types {
			objects.types[declaration] = name
		}
		for name, fields := range declared.fields {
			objects.fields[name] = fields
		}
		for _, path := range engineImports(file) {
			if path == engineImport || functions[path] != nil {
				continue
			}
			directory := filepath.Join("..", "engine", strings.TrimPrefix(path, engineImport+"/"))
			packages, err := parser.ParseDir(token.NewFileSet(), directory, func(info fs.FileInfo) bool {
				return !strings.HasSuffix(info.Name(), "_test.go")
			}, 0)
			if err != nil {
				t.Fatal(err)
			}
			functions[path] = map[string]bool{}
			for _, pkg := range packages {
				for _, source := range pkg.Files {
					for _, declaration := range source.Decls {
						if function, ok := declaration.(*ast.FuncDecl); ok && function.Recv == nil {
							functions[path][function.Name.Name] = true
						}
					}
				}
			}
		}
	}
	for name, file := range parsed {
		for _, reference := range forbiddenServerReferences(name, file, objects, functions) {
			t.Errorf("%s references %s; server operations must use the engine facade", name, reference)
		}
	}
}

func engineImports(file *ast.File) map[string]string {
	packages := map[string]string{}
	for _, entry := range file.Imports {
		path, _ := strconv.Unquote(entry.Path.Value)
		if path != engineImport && !strings.HasPrefix(path, engineImport+"/") {
			continue
		}
		alias := filepath.Base(path)
		if entry.Name != nil {
			alias = entry.Name.Name
		}
		packages[alias] = path
	}
	return packages
}

type serverObjects struct {
	types  map[any]string
	fields map[string]map[string]string
}

func serverTypeName(expression ast.Expr, packages map[string]string) string {
	switch expression := expression.(type) {
	case *ast.StarExpr:
		return serverTypeName(expression.X, packages)
	case *ast.Ident:
		return expression.Name
	case *ast.SelectorExpr:
		if alias, ok := expression.X.(*ast.Ident); ok && packages[alias.Name] != "" {
			return packages[alias.Name] + "." + expression.Sel.Name
		}
	}
	return ""
}

func engineObjectNames(file *ast.File) serverObjects {
	packages := engineImports(file)
	objects := serverObjects{types: map[any]string{}, fields: map[string]map[string]string{}}
	ast.Inspect(file, func(node ast.Node) bool {
		switch declaration := node.(type) {
		case *ast.Field:
			objects.types[declaration] = serverTypeName(declaration.Type, packages)
		case *ast.ValueSpec:
			objects.types[declaration] = serverTypeName(declaration.Type, packages)
		case *ast.TypeSpec:
			structure, ok := declaration.Type.(*ast.StructType)
			if !ok {
				return true
			}
			fields := map[string]string{}
			for _, field := range structure.Fields.List {
				for _, name := range field.Names {
					fields[name.Name] = serverTypeName(field.Type, packages)
				}
			}
			objects.fields[declaration.Name.Name] = fields
		}
		return true
	})
	return objects
}

func forbiddenServerReferences(name string, file *ast.File, objects serverObjects, functions map[string]map[string]bool) []string {
	packages := engineImports(file)
	var forbidden []string
	for alias, path := range packages {
		if alias == "." || alias == "_" {
			forbidden = append(forbidden, path)
		}
	}
	for _, declaration := range file.Decls {
		function, _ := declaration.(*ast.FuncDecl)
		location := name
		if function != nil {
			location += "/" + function.Name.Name
		}
		ast.Inspect(declaration, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if slices.Contains([]string{"Bus", "Groups", "Tasks", "Board", "Workspaces", "Terminals"}, selector.Sel.Name) && engineObject(selector.X, objects) {
				forbidden = append(forbidden, "Engine."+selector.Sel.Name)
			}
			alias, ok := selector.X.(*ast.Ident)
			if !ok || alias.Obj != nil {
				return true
			}
			path := packages[alias.Name]
			if functions[path][selector.Sel.Name] && !serverHostFunction(location, path+"."+selector.Sel.Name) {
				forbidden = append(forbidden, strings.TrimPrefix(path, engineImport+"/")+"."+selector.Sel.Name)
			}
			return true
		})
	}
	return forbidden
}

func engineObject(expression ast.Expr, objects serverObjects) bool {
	return serverObjectType(expression, objects, map[ast.Expr]bool{}) == engineImport+".Engine"
}

func serverObjectType(expression ast.Expr, objects serverObjects, visited map[ast.Expr]bool) string {
	if expression == nil || visited[expression] {
		return ""
	}
	visited[expression] = true
	switch expression := expression.(type) {
	case *ast.ParenExpr:
		return serverObjectType(expression.X, objects, visited)
	case *ast.StarExpr:
		return serverObjectType(expression.X, objects, visited)
	case *ast.UnaryExpr:
		return serverObjectType(expression.X, objects, visited)
	case *ast.SelectorExpr:
		return objects.fields[serverObjectType(expression.X, objects, visited)][expression.Sel.Name]
	case *ast.CompositeLit:
		return serverTypeName(expression.Type, nil)
	case *ast.Ident:
		if expression.Obj == nil {
			return ""
		}
		if name := objects.types[expression.Obj.Decl]; name != "" {
			return name
		}
		switch declaration := expression.Obj.Decl.(type) {
		case *ast.AssignStmt:
			for index, left := range declaration.Lhs {
				if identifier, ok := left.(*ast.Ident); ok && identifier.Name == expression.Name && index < len(declaration.Rhs) {
					return serverObjectType(declaration.Rhs[index], objects, visited)
				}
			}
		case *ast.ValueSpec:
			for index, name := range declaration.Names {
				if name.Name == expression.Name && index < len(declaration.Values) {
					return serverObjectType(declaration.Values[index], objects, visited)
				}
			}
		}
	}
	return ""
}

func serverHostFunction(location, reference string) bool {
	if reference == engineImport+"/agent/model/anthropic.New" || reference == engineImport+"/agent/model/openai.New" {
		return true
	}
	// Existing host duties are limited to their current functions. Storage exceptions disappear when those
	// implementations move out of the engine; model configuration and request IDs remain host responsibilities.
	allowed := map[string][]string{
		"config.go/environmentSource":       {"agent/model/anthropic.Builtin", "agent/model/openai.Builtin"},
		"config.go/applyConfiguration":      {"agent/model/anthropic.Builtin", "agent/model/openai.Builtin"},
		"cloud.go/loginCloud":               {"infra/event.NewID"},
		"methods_events.go/eventMethods":    {"infra/event.NewID"},
		"approval.go/offerPendingApprovals": {"infra/event.Decode"},
		"server.go/ServeHTTP":               {"infra/event.Decode"},
	}
	return slices.Contains(allowed[location], strings.TrimPrefix(reference, engineImport+"/"))
}

func TestServerArchitectureRecognizesFunctionsAndEngineObjects(t *testing.T) {
	functions := map[string]map[string]bool{
		engineImport + "/agent/rules":        {"Load": true},
		engineImport + "/agent/model/openai": {"New": true, "Builtin": true},
		engineImport + "/infra/event":        {"Decode": true},
	}
	for _, test := range []struct {
		name, body string
		forbidden  bool
	}{
		{"facade method", `s.engine.ListSessions(ctx)`, false},
		{"event bus", `s.engine.Bus.Subscribe(filter)`, true},
		{"group manager", `s.engine.Groups.Get(ctx, id)`, true},
		{"task pool", `s.engine.Tasks.Get(ctx, id)`, true},
		{"board", `s.engine.Board.Groups(ctx, id)`, true},
		{"workspaces", `s.engine.Workspaces.Get(ctx, id)`, true},
		{"terminals", `s.engine.Terminals.Get(id)`, true},
		{"engine alias", `instance := s.engine; instance.Tasks.Get(ctx, id)`, true},
		{"typed engine", `var instance *engine.Engine; instance.Bus.Subscribe(filter)`, true},
		{"declared engine alias", `var copied = s.engine; copied.Tasks.Get(ctx, id)`, true},
		{"unrelated same-name variable", `instance := struct{ Bus int }{}; _ = instance.Bus`, false},
		{"unrelated same-name field", `value := Decoy{}; _ = value.engine.Bus`, false},
		{"dereferenced engine", `(*s.engine).Tasks.Get(ctx, id)`, true},
		{"child function", `rules.Load(ctx, directory)`, true},
		{"function alias", `load := rules.Load; _ = load`, true},
		{"generic function", `event.Decode[permission.Request](fact)`, true},
		{"type conversion", `permission.Mode(value)`, false},
		{"constant", `_ = permission.Allow`, false},
		{"data type", `_ = rules.Set{}`, false},
		{"provider constructor", `openai.New(options)`, false},
		{"provider config outside host function", `openai.Builtin(name)`, true},
		{"shadowed import", `rules := local; rules.Load()`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := `package server
import (
 "github.com/TongTong313/merakcode/merak/engine"
 "github.com/TongTong313/merakcode/merak/engine/agent/rules"
 "github.com/TongTong313/merakcode/merak/engine/agent/permission"
 "github.com/TongTong313/merakcode/merak/engine/agent/model/openai"
 "github.com/TongTong313/merakcode/merak/engine/infra/event"
)
type Server struct { engine *engine.Engine }
type Decoy struct { engine struct { Bus int } }
func other(instance *engine.Engine) {}
func (s *Server) run() { ` + test.body + ` }`
			file, err := parser.ParseFile(token.NewFileSet(), "fixture.go", source, 0)
			if err != nil {
				t.Fatal(err)
			}
			found := forbiddenServerReferences("fixture.go", file, engineObjectNames(file), functions)
			if got := len(found) != 0; got != test.forbidden {
				t.Fatalf("forbidden=%v want=%v: %v", got, test.forbidden, found)
			}
		})
	}
}
