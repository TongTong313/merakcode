package cli

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestProductCommandsOnlyReachEngineThroughProtocol(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, reference := range forbiddenEngineReferences(name, file) {
			t.Errorf("%s references %s; product commands must use the protocol", name, reference)
		}
	}
}

func TestArchitectureRejectsEngineCallsAndFunctionAliases(t *testing.T) {
	for _, test := range []struct {
		name, source string
		forbidden    bool
	}{
		{"direct call", `package cli; import "github.com/TongTong313/merakcode/merak/engine/mcp"; func run() { mcp.Dial() }`, true},
		{"function alias", `package cli; import x "github.com/TongTong313/merakcode/merak/engine/mcp"; var dial = x.Dial`, true},
		{"engine method", `package cli; import "github.com/TongTong313/merakcode/merak/engine"; var instance *engine.Engine`, true},
		{"event contract", `package cli; import "github.com/TongTong313/merakcode/merak/engine/event"; var id event.ID`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			file, err := parser.ParseFile(token.NewFileSet(), "fixture.go", test.source, 0)
			if err != nil {
				t.Fatal(err)
			}
			if got := len(forbiddenEngineReferences("fixture.go", file)) != 0; got != test.forbidden {
				t.Fatalf("forbidden=%v want=%v", got, test.forbidden)
			}
		})
	}
}

// Product commands may interpret public wire data and construct request defaults.
// Runtime objects and functions stay behind the SDK or an explicit host entry.
func forbiddenEngineReferences(name string, file *ast.File) []string {
	if name == "serve.go" {
		return nil
	}
	contracts := map[string]string{
		"engine":               "Shutdown",
		"engine/event":         "Decode Event Filter ID Lagged NewID Scope Type",
		"engine/loop":          "Answered BudgetStop Cancelled Outcome TurnFinished",
		"engine/model":         "Chunk Part ReasoningChunk Text Thinking ThinkingHigh ThinkingLow ThinkingMax ThinkingMedium ThinkingOff ThinkingXHigh ToolCall Usage",
		"engine/model/catalog": "Model",
		"engine/model/fake":    "Reply",
		"engine/permission":    "Allow Deny Reply Request Requested",
		"engine/agent":         "DefaultWorker Product",
		"engine/question":      "Answer Asked Request",
		"engine/session":       "Completion MessageCompleted MessageDelta",
		"engine/task":          "Report",
		"engine/tool":          "Call Called Completed Completion EffectExec",
		"engine/worker":        "Kind KindACP KindClaudeCode KindCodex KindCommand KindOpenCode KindPi",
	}
	hostCalls := map[string]string{
		"cli.go/debugChat":      "engine/model/fake.New",
		"code_read.go/readCode": "engine/tool.ReadCode",
	}
	packages := map[string]string{}
	var forbidden []string
	for _, entry := range file.Imports {
		path, _ := strconv.Unquote(entry.Path.Value)
		path, owned := strings.CutPrefix(path, "github.com/TongTong313/merakcode/merak/")
		if !owned || path != "engine" && !strings.HasPrefix(path, "engine/") {
			continue
		}
		alias := filepath.Base(path)
		if entry.Name != nil {
			alias = entry.Name.Name
		}
		if alias == "." || alias == "_" {
			forbidden = append(forbidden, path)
		}
		packages[alias] = path
	}
	for _, declaration := range file.Decls {
		function, _ := declaration.(*ast.FuncDecl)
		ast.Inspect(declaration, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			alias, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			path, enginePackage := packages[alias.Name]
			if !enginePackage {
				return true
			}
			// These two host functions assemble an isolated model or execute an
			// engine-requested sandbox child. Neither is a product operation.
			reference := path + "." + selector.Sel.Name
			if function != nil && hostCalls[name+"/"+function.Name.Name] == reference {
				return true
			}
			if !slices.Contains(strings.Fields(contracts[path]), selector.Sel.Name) {
				forbidden = append(forbidden, reference)
			}
			return true
		})
	}
	return forbidden
}
