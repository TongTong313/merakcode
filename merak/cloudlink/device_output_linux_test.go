package cloudlink_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
)

func TestDeviceReadOutputIsReturnedAndOversizedEncodedOutputIsRejected(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
	defer cancel()
	binary := os.Getenv("MERAK_TEST_BINARY")
	if binary == "" {
		binary = filepath.Join(t.TempDir(), "merak")
		command := exec.CommandContext(ctx, "go", "build", "-o", binary, "github.com/TongTong313/merakcode/merak/cmd/merak")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build = %s, error = %v", output, err)
		}
	}
	for _, scenario := range []struct {
		name, content, want, cloudWant, code string
	}{
		// Cloud projection retains the input path while removing file contents.
		{"read", "alpha\nbeta\n", "alpha\nbeta\n", `{"lines":2,"path":"input.txt"}`, ""},
		// The file is below the 4 MiB read limit; JSON escaping exceeds the 8 MiB output limit.
		// Cloud projection also replaces error text with metadata, while retaining its error code.
		{"encoded output limit", strings.Repeat("\x01", 2<<20), "MRK-5001", `{"lines":1,"path":"input.txt"}`, "MRK-5001"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "input.txt"), []byte(scenario.content), 0600); err != nil {
				t.Fatal(err)
			}
			peer := testcloud.New(t)
			deps := enginetest.Deps(t)
			deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
			deps.Store = memory.New()
			deps.Workdir = directory
			deps.MCPCommand = binary
			e, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			if _, err = e.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "reader", Project: group.Project{Directory: directory}}, []group.Member{{ID: "reader", Name: "Reader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"}}); err != nil {
				t.Fatal(err)
			}
			facts, stop := e.Subscribe(event.Filter{Types: []event.Type{tool.Completed}})
			defer stop()
			if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
				t.Fatal(err)
			}
			stateBody, _ := json.Marshal(group.State{Group: group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud"}})
			if err = peer.Send(ctx, wire.CloudInbound{Events: []event.Event{{ID: "cloud-created", Stream: "group:cloud-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: "cloud-group"}, Payload: stateBody}}, ToolCall: &wire.DeviceToolCall{SourceGroup: "source", Member: "reader", Scope: event.Scope{Group: "cloud-group"}, Call: tool.Call{ID: "read", Name: "read_file", Input: json.RawMessage(`{"path":"input.txt"}`)}}}); err != nil {
				t.Fatal(err)
			}
			var local event.Event
			select {
			case local = <-facts:
				completion, err := event.Decode[tool.Completion](local)
				if err != nil || completion.CallID != "read" || completion.Name != "read_file" || completion.Code != scenario.code || completion.IsError != (scenario.code != "") || len(completion.Parts) != 1 || completion.Parts[0].Text != scenario.want {
					t.Fatalf("local completion = %+v, error = %v", completion, err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			for {
				select {
				case fact := <-peer.Published:
					if fact.ID != local.ID {
						continue
					}
					completion, err := event.Decode[tool.Completion](fact)
					if err != nil || completion.CallID != "read" || completion.Code != scenario.code || completion.IsError != (scenario.code != "") || len(completion.Parts) != 1 || completion.Parts[0].Text != scenario.cloudWant {
						t.Fatalf("cloud completion = %+v, error = %v", completion, err)
					}
					return
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}
