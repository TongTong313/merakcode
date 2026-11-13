//go:build sandbox_integration

package engine_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/tool"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestEngineSandboxPublishesTheDeniedPathAndMember(t *testing.T) {
	workspace, outside := t.TempDir(), filepath.Join(t.TempDir(), "outside")
	e, err := engine.New(engine.Deps{SandboxStateDir: os.Getenv("MERAKCODE_SANDBOX_TEST_STATE")})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	p := agent.DefaultMerakCode()
	p.Name = "Denied writer"
	p.Product = &agent.Product{Kind: worker.KindCommand, Binary: os.Args[0], Args: []string{"--merak-protection-event-fixture", outside}}
	run, err := e.StartWorker(t.Context(), p, worker.Assignment{Session: event.NewID(), Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(t.Context()); err == nil {
		t.Fatalf("outside write succeeded: path=%s", outside)
	}
	for fact := range run.Events() {
		if fact.Type != tool.Completed {
			continue
		}
		result, err := event.Decode[tool.Completion](fact)
		if err != nil {
			t.Fatal(err)
		}
		if result.Code == "MRK-5009" && result.IsError && result.MemberName == p.Name {
			for _, part := range result.Parts {
				if strings.Contains(part.Text, outside) {
					return
				}
			}
		}
	}
	t.Fatalf("missing file denial event: member=%s path=%s", p.Name, outside)
}
