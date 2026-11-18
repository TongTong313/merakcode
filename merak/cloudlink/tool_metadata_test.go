package cloudlink_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/tool"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
)

func TestCloudToolResultsKeepTheOriginalCallsFileMetadata(t *testing.T) {
	for _, scenario := range []struct {
		name, stream, session string
		cause                 bool
	}{
		{"interleaved session calls", "session:metadata", "metadata", true},
		{"interleaved device calls", "device:metadata:group:shared", "", true},
		{"legacy device result ignores another stream", "device:metadata:group:shared", "", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			peer := testcloud.New(t)
			storage := memory.New()
			marshal := func(value any) json.RawMessage { body, _ := json.Marshal(value); return body }
			call := func(path string) json.RawMessage {
				return marshal(model.ToolCall{ID: "reused", Name: "read_file", Input: marshal(map[string]string{"path": path})})
			}
			facts := []event.Event{{ID: "first-call", Type: tool.Called, Payload: call("first.txt")}}
			if scenario.cause {
				facts = append(facts, event.Event{ID: "second-call", Type: tool.Called, Payload: call("second.txt")})
			}
			result := event.Event{ID: "first-result", Type: tool.Completed, Payload: marshal(tool.Completion{CallID: "reused", Name: "read_file", Result: tool.Result{Parts: []model.Part{{Text: "private-file-body\n"}}}})}
			if scenario.cause {
				result.Cause = "first-call"
			}
			facts = append(facts, result)
			for i := range facts {
				facts[i].Stream, facts[i].Seq, facts[i].Time = event.Stream(scenario.stream), uint64(i+1), time.Now()
				facts[i].Scope = event.Scope{Group: "shared", Session: event.ID(scenario.session)}
			}
			if err := storage.Append(ctx, facts); err != nil {
				t.Fatal(err)
			}
			other := event.Event{ID: "other-call", Stream: "device:other:group:shared", Seq: 1, Time: time.Now(), Type: tool.Called, Scope: event.Scope{Group: "shared"}, Payload: call("other.txt")}
			if err := storage.Append(ctx, []event.Event{other}); err != nil {
				t.Fatal(err)
			}
			if err := storage.Put(ctx, store.Doc{Kind: "cloud-stream", Key: scenario.stream, Body: []byte(`0`), Meta: map[string]string{"host": wire.Identity(peer.Credentials())}}); err != nil {
				t.Fatal(err)
			}
			deps := enginetest.Deps(t)
			deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
			deps.Store, deps.Workdir = storage, t.TempDir()
			e, err := engine.New(deps)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			if err := e.ConnectCloud(ctx, peer.Credentials()); err != nil {
				t.Fatal(err)
			}
			for {
				select {
				case fact := <-peer.Published:
					if fact.ID != result.ID {
						continue
					}
					completion, err := event.Decode[tool.Completion](fact)
					if err != nil || len(completion.Parts) != 1 || completion.Parts[0].Text != `{"lines":1,"path":"first.txt"}` {
						t.Fatalf("completion=%+v, error=%v", completion, err)
					}
					saved, err := e.GetEvent(ctx, result.ID)
					if err != nil || !strings.Contains(string(saved.Payload), "private-file-body") {
						t.Fatal("cloud projection changed local history")
					}
					return
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
		})
	}
}
