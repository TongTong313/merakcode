package conversation_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/conversation"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/agent/permission"
	"github.com/TongTong313/merakcode/merak/engine/agent/session"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/infra/errorcode"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/engine/infra/process"
	"github.com/TongTong313/merakcode/merak/engine/infra/store"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
)

func newExternalRig(t *testing.T, providers map[string]model.Provider) *enginetest.ExternalRig {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	t.Cleanup(cancel)
	bin := filepath.Join(t.TempDir(), "claude.exe")
	if out, err := process.Command(ctx, "", "go", "build", "-o", bin, "github.com/TongTong313/merakcode/merak/engine/collab/worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	dir := t.TempDir()
	deps := enginetest.Deps(t)
	deps.Workdir = dir
	deps.Providers = providers
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	external := definition.DefaultMerakCode()
	external.Name, external.Mode = "Claude", permission.ModeTakeover
	external.Product = &definition.Product{Kind: definition.KindClaudeCode, Binary: bin}
	saved, err := e.SaveAgent(ctx, "owner", external)
	if err != nil {
		t.Fatal(err)
	}
	return &enginetest.ExternalRig{T: t, Engine: e, Context: ctx, Directory: dir, Agent: saved}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *errorcode.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error=%v, want code %s", err, code)
	}
}

func TestADisabledAgentKeepsItsFlagAndNeitherStartsNorContinuesAChatNorTakesASeat(t *testing.T) {
	r := newExternalRig(t, nil)
	id, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	r.Say(id, "First message", 1)
	r.SetDisabled(true)
	listed, err := r.Engine.ListAgents(r.Context, "owner")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range listed {
		if p.ID == r.Agent.ID {
			found = p.Disabled
		}
	}
	if !found {
		t.Fatalf("the flag was not kept: %+v", listed)
	}
	wantCode(t, r.Engine.Send(r.Context, id, []model.Part{{Text: "Second message"}}), errorcode.AgentDisabled)
	_, err = r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	wantCode(t, err, errorcode.AgentDisabled)
	_, err = r.Engine.CreateGroup(r.Context, group.Group{Kind: group.KindLocal, Name: "Seats", Project: group.Project{Directory: t.TempDir()}, Leader: "owner"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "seat", Name: "Seat", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: r.Agent.ID, Owner: "owner"},
	})
	wantCode(t, err, errorcode.AgentDisabled)
	r.SetDisabled(false)
	r.Say(id, "Second message", 2)
}

func TestTheAgentOfAnExternalConversationIsToldToTheClient(t *testing.T) {
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t)})
	external, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	native, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Provider: "fake", Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := r.Engine.ExternalAgent(r.Context, external); err != nil || got != r.Agent.ID {
		t.Fatalf("external agent=%q err=%v", got, err)
	}
	if got, err := r.Engine.ExternalAgent(r.Context, native); err != nil || got != "" {
		t.Fatalf("native agent=%q err=%v", got, err)
	}
}

func TestTakingOverAnExternalConversationKeepsItsHistoryAndContinuesWithTheNativeModel(t *testing.T) {
	var seen []model.Request
	record := func(request model.Request) error { seen = append(seen, request); return nil }
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Native answer.", Expect: record})})
	id, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	r.Say(id, "First message", 1)
	if err := r.Engine.TakeOverSession(r.Context, id, false, session.Selection{Provider: "fake", Model: "tiny"}); err == nil {
		t.Fatal("a takeover without confirmation was accepted")
	} else {
		wantCode(t, err, errorcode.TakeoverNeedsConfirmation)
	}
	if got, _ := r.Engine.ExternalAgent(r.Context, id); got != r.Agent.ID {
		t.Fatalf("the refused takeover changed the conversation: agent=%q", got)
	}
	if err := r.Engine.TakeOverSession(r.Context, id, true, session.Selection{Provider: "missing", Model: "tiny"}); err == nil {
		t.Fatal("a takeover with an unconfigured model was accepted")
	}
	if got, _ := r.Engine.ExternalAgent(r.Context, id); got != r.Agent.ID {
		t.Fatalf("the refused takeover changed the conversation: agent=%q", got)
	}
	if err := r.Engine.TakeOverSession(r.Context, id, true, session.Selection{Provider: "fake", Model: "tiny"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := r.Engine.ExternalAgent(r.Context, id); got != "" {
		t.Fatalf("the conversation is still external: agent=%q", got)
	}
	facts, stop := r.Engine.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
	defer stop()
	if err := r.Engine.Send(r.Context, id, []model.Part{{Text: "Continue natively"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-r.Context.Done():
		t.Fatal("the native model did not answer")
	}
	if len(seen) != 1 {
		t.Fatalf("model requests=%d", len(seen))
	}
	var history strings.Builder
	for _, message := range seen[0].Messages {
		for _, part := range message.Parts {
			history.WriteString(part.Text + "\n")
		}
	}
	if !strings.Contains(history.String(), "First message") || !strings.Contains(history.String(), "Checked README.") || !strings.Contains(history.String(), "Continue natively") {
		t.Fatalf("the model did not get the external history:\n%s", history.String())
	}
	created, err := r.Engine.FindEvents(r.Context, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.Created}})
	if err != nil || len(created) != 1 {
		t.Fatalf("created=%d err=%v", len(created), err)
	}
	if err := r.Engine.TakeOverSession(r.Context, id, true, session.Selection{Provider: "fake", Model: "tiny"}); err == nil {
		t.Fatal("a native conversation was taken over again")
	}
}

func TestTheFirstAnswerOfAnExternalConversationGetsATitleFromTheSmallModel(t *testing.T) {
	var asked []model.Request
	record := func(request model.Request) error { asked = append(asked, request); return nil }
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "\"Direct title\"", Expect: record})})
	r.Engine.SetSmallModel("fake", "tiny")
	id, err := r.Engine.CreateSession(r.Context, conversation.SessionOptions{Agent: r.Agent.ID, Workdir: r.Directory})
	if err != nil {
		t.Fatal(err)
	}
	title := func() string {
		list, err := r.Engine.ListSessions(r.Context)
		if err != nil {
			t.Fatal(err)
		}
		for _, info := range list {
			if info.ID == id {
				return info.Title
			}
		}
		return ""
	}
	r.Say(id, "Name this chat after my first message", 1)
	enginetest.WaitFor(t, r.Context, "the title", func() bool { return title() != "" })
	if title() != "Direct title" {
		t.Fatalf("title=%q", title())
	}
	if len(asked) != 1 || !strings.Contains(asked[0].Messages[0].Parts[0].Text, "Name this chat after my first message") {
		t.Fatalf("the title request did not carry the first message: %+v", asked)
	}
	r.Say(id, "A second message", 2)
	time.Sleep(200 * time.Millisecond)
	if len(asked) != 1 {
		t.Fatalf("a later answer asked for another title: %d requests", len(asked))
	}
}
