package engine_test

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/profile"
	storememory "github.com/TongTong313/merakcode/merak/engine/store/memory"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/task"
	"github.com/TongTong313/merakcode/merak/engine/worker"
)

func TestGroupLookupAndDocumentsRejectAnotherGroupsData(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	storage := storememory.New()
	type check struct {
		name    string
		input   json.RawMessage
		denied  bool
		excerpt bool
	}
	var checks []check
	index := 0
	provider := groupScript{name: "lookup", test: t, reply: func(req model.Request) fake.Reply {
		if index > 0 {
			expected := checks[index-1]
			last := req.Messages[len(req.Messages)-1]
			if len(last.Parts) == 0 || last.Parts[0].ToolResult == nil {
				t.Error("missing tool result")
			} else {
				result := last.Parts[0].ToolResult
				body, _ := json.Marshal(result)
				if result.IsError != expected.denied {
					t.Errorf("input=%s result=%s", expected.input, body)
				}
				if expected.denied && strings.Contains(string(body), "line three") {
					t.Error("foreign document leaked")
				}
				if expected.excerpt && (strings.Contains(string(body), "line one") || !strings.Contains(string(body), "first")) {
					t.Errorf("document=%s", body)
				}
			}
		}
		if index == len(checks) {
			return integrationCall("submit_report", map[string]any{"verdict": "done", "summary": "Checked references"})
		}
		current := checks[index]
		index++
		return fake.Reply{Calls: []model.ToolCall{{ID: fmt.Sprint(index), Name: current.name, Input: current.input}}}
	}}
	e, err := engine.New(engine.Deps{Store: storage, Providers: map[string]model.Provider{"lookup": provider}})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	var groups []group.Group
	var cards []task.Card
	var facts []event.Event
	for _, name := range []string{"first", "second"} {
		g, err := e.Groups.Create(t.Context(), group.Group{Kind: group.KindLocal, Name: name, DefaultLeader: "leader", Project: group.Project{Directory: t.TempDir()}}, []group.Member{{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader}, {ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner}, {ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Profile: "builtin-worker"}})
		if err != nil {
			t.Fatal(err)
		}
		groups = append(groups, g)
		card, err := e.Tasks.Create(t.Context(), task.Card{Group: g.ID, Title: name})
		if err != nil {
			t.Fatal(err)
		}
		cards = append(cards, card)
		fact, err := e.Bus.Publish(t.Context(), event.Event{Stream: event.Stream("session:" + name), Scope: event.Scope{Group: g.ID, Session: event.ID(name)}, Type: "fixture.message", Payload: json.RawMessage(`{"text":"` + name + `"}`)})
		if err != nil {
			t.Fatal(err)
		}
		facts = append(facts, fact)
		for _, doc := range []store.Doc{{Kind: "blob", Key: name, Body: []byte(name), Meta: map[string]string{"group": string(g.ID)}}, {Kind: "shared", Key: string(g.ID) + "/design", Body: []byte("line one\n" + name + "\nline three"), Meta: map[string]string{"group": string(g.ID)}}} {
			if err := storage.Put(t.Context(), doc); err != nil {
				t.Fatal(err)
			}
		}
	}
	for index, g := range groups {
		for _, ref := range []string{"mrk://group/" + string(g.ID) + "/task/" + string(cards[index].ID), "mrk://event/" + string(facts[index].ID), "mrk://session/" + string(facts[index].Scope.Session) + "#1", "mrk://blob/" + g.Name, "mrk://doc/shared/" + string(g.ID) + "/design"} {
			input, _ := json.Marshal(map[string]string{"ref": ref})
			checks = append(checks, check{name: "lookup", input: input, denied: index == 1})
		}
	}
	checks = append(checks, check{name: "read_doc", input: json.RawMessage(`{"key":"design","startLine":2,"endLine":2}`), excerpt: true})
	p := profile.DefaultWorker()
	p.Model.Provider = "lookup"
	run, err := e.StartWorker(ctx, p, worker.Assignment{Scope: event.Scope{Group: groups[0].ID, Task: cards[0].ID}, Session: "lookup", Claim: task.Claim{ID: "claim", Task: cards[0].ID, Member: "worker"}, Workdir: t.TempDir(), Packet: "Check references"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if index != len(checks) {
		t.Fatalf("checked=%d want=%d", index, len(checks))
	}
}
