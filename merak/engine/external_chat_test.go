package engine_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/model"
	"github.com/TongTong313/merakcode/merak/engine/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/engine/session"
	"github.com/TongTong313/merakcode/merak/engine/store"
	"github.com/TongTong313/merakcode/merak/engine/worker"
	"github.com/TongTong313/merakcode/merak/internal/platform/errorcode"
	"github.com/TongTong313/merakcode/merak/internal/platform/process"
)

// externalRig is an engine with a saved external agent that runs the Claude Code fixture.
type externalRig struct {
	t     *testing.T
	e     *engine.Engine
	ctx   context.Context
	dir   string
	agent agent.Agent
}

func newExternalRig(t *testing.T, providers map[string]model.Provider) *externalRig {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	t.Cleanup(cancel)
	bin := filepath.Join(t.TempDir(), "claude.exe")
	if out, err := process.Command(ctx, "", "go", "build", "-o", bin, "./worker/claudecode/testdata/fakeclaude").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	dir := t.TempDir()
	e, err := engine.New(engine.Deps{Workdir: dir, Providers: providers})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.Close() })
	external := agent.DefaultWorker()
	external.Name, external.Mode = "Claude", permission.ModeTakeover
	external.Product = &agent.Product{Kind: worker.KindClaudeCode, Binary: bin}
	saved, err := e.SaveAgent(ctx, "owner", external)
	if err != nil {
		t.Fatal(err)
	}
	return &externalRig{t: t, e: e, ctx: ctx, dir: dir, agent: saved}
}

func (r *externalRig) answers(id event.ID) int {
	r.t.Helper()
	facts, err := r.e.FindEvents(r.ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
	if err != nil {
		r.t.Fatal(err)
	}
	return len(facts)
}

// say sends a message to an external conversation and waits for the answer number want.
func (r *externalRig) say(id event.ID, text string, want int) {
	r.t.Helper()
	if err := r.e.Send(r.ctx, id, []model.Part{{Text: text}}); err != nil {
		r.t.Fatal(err)
	}
	waitFor(r.t, r.ctx, "answer "+text, func() bool { return r.answers(id) >= want })
}

func (r *externalRig) setDisabled(disabled bool) {
	r.t.Helper()
	saved := r.agent
	saved.Disabled = disabled
	if _, err := r.e.SaveAgent(r.ctx, "owner", saved); err != nil {
		r.t.Fatal(err)
	}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *engine.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error=%v, want code %s", err, code)
	}
}

func TestADisabledAgentKeepsItsFlagAndNeitherStartsNorContinuesAChatNorTakesASeat(t *testing.T) {
	r := newExternalRig(t, nil)
	id, err := r.e.CreateSession(r.ctx, engine.SessionOptions{Agent: r.agent.ID, Workdir: r.dir})
	if err != nil {
		t.Fatal(err)
	}
	r.say(id, "First message", 1)
	r.setDisabled(true)
	listed, err := r.e.ListAgents(r.ctx, "owner")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range listed {
		if p.ID == r.agent.ID {
			found = p.Disabled
		}
	}
	if !found {
		t.Fatalf("the flag was not kept: %+v", listed)
	}
	wantCode(t, r.e.Send(r.ctx, id, []model.Part{{Text: "Second message"}}), errorcode.AgentDisabled)
	_, err = r.e.CreateSession(r.ctx, engine.SessionOptions{Agent: r.agent.ID, Workdir: r.dir})
	wantCode(t, err, errorcode.AgentDisabled)
	_, err = r.e.CreateGroup(r.ctx, group.Group{Kind: group.KindLocal, Name: "Seats", Project: group.Project{Directory: t.TempDir()}, Leader: "owner"}, []group.Member{
		{ID: "owner", Name: "Owner", Kind: group.MemberHuman, Role: group.RoleOwner},
		{ID: "seat", Name: "Seat", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: r.agent.ID, Owner: "owner"},
	})
	wantCode(t, err, errorcode.AgentDisabled)
	r.setDisabled(false)
	r.say(id, "Second message", 2)
}

func TestTheAgentOfAnExternalConversationIsToldToTheClient(t *testing.T) {
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t)})
	external, err := r.e.CreateSession(r.ctx, engine.SessionOptions{Agent: r.agent.ID, Workdir: r.dir})
	if err != nil {
		t.Fatal(err)
	}
	native, err := r.e.CreateSession(r.ctx, engine.SessionOptions{Provider: "fake", Workdir: r.dir})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := r.e.ExternalAgent(r.ctx, external); err != nil || got != r.agent.ID {
		t.Fatalf("external agent=%q err=%v", got, err)
	}
	if got, err := r.e.ExternalAgent(r.ctx, native); err != nil || got != "" {
		t.Fatalf("native agent=%q err=%v", got, err)
	}
}

func TestTakingOverAnExternalConversationKeepsItsHistoryAndContinuesWithTheNativeModel(t *testing.T) {
	var seen []model.Request
	record := func(request model.Request) error { seen = append(seen, request); return nil }
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "Native answer.", Expect: record})})
	id, err := r.e.CreateSession(r.ctx, engine.SessionOptions{Agent: r.agent.ID, Workdir: r.dir})
	if err != nil {
		t.Fatal(err)
	}
	r.say(id, "First message", 1)
	if err := r.e.TakeOverSession(r.ctx, id, false, session.Selection{Provider: "fake", Model: "tiny"}); err == nil {
		t.Fatal("a takeover without confirmation was accepted")
	} else {
		wantCode(t, err, errorcode.TakeoverNeedsConfirmation)
	}
	if got, _ := r.e.ExternalAgent(r.ctx, id); got != r.agent.ID {
		t.Fatalf("the refused takeover changed the conversation: agent=%q", got)
	}
	if err := r.e.TakeOverSession(r.ctx, id, true, session.Selection{Provider: "missing", Model: "tiny"}); err == nil {
		t.Fatal("a takeover with an unconfigured model was accepted")
	}
	if got, _ := r.e.ExternalAgent(r.ctx, id); got != r.agent.ID {
		t.Fatalf("the refused takeover changed the conversation: agent=%q", got)
	}
	if err := r.e.TakeOverSession(r.ctx, id, true, session.Selection{Provider: "fake", Model: "tiny"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := r.e.ExternalAgent(r.ctx, id); got != "" {
		t.Fatalf("the conversation is still external: agent=%q", got)
	}
	facts, stop := r.e.Bus.Subscribe(event.Filter{Scope: event.Scope{Session: id}, Types: []event.Type{session.MessageCompleted}})
	defer stop()
	if err := r.e.Send(r.ctx, id, []model.Part{{Text: "Continue natively"}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-facts:
	case <-r.ctx.Done():
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
	created, err := r.e.FindEvents(r.ctx, store.Query{Scope: event.Scope{Session: id}, Types: []event.Type{session.Created}})
	if err != nil || len(created) != 1 {
		t.Fatalf("created=%d err=%v", len(created), err)
	}
	if err := r.e.TakeOverSession(r.ctx, id, true, session.Selection{Provider: "fake", Model: "tiny"}); err == nil {
		t.Fatal("a native conversation was taken over again")
	}
}

func TestTheFirstAnswerOfAnExternalConversationGetsATitleFromTheSmallModel(t *testing.T) {
	var asked []model.Request
	record := func(request model.Request) error { asked = append(asked, request); return nil }
	r := newExternalRig(t, map[string]model.Provider{"fake": fake.New(t, fake.Reply{Text: "\"Direct title\"", Expect: record})})
	r.e.SetSmallModel("fake", "tiny")
	id, err := r.e.CreateSession(r.ctx, engine.SessionOptions{Agent: r.agent.ID, Workdir: r.dir})
	if err != nil {
		t.Fatal(err)
	}
	title := func() string {
		list, err := r.e.ListSessions(r.ctx)
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
	r.say(id, "Name this chat after my first message", 1)
	waitFor(t, r.ctx, "the title", func() bool { return title() != "" })
	if title() != "Direct title" {
		t.Fatalf("title=%q", title())
	}
	if len(asked) != 1 || !strings.Contains(asked[0].Messages[0].Parts[0].Text, "Name this chat after my first message") {
		t.Fatalf("the title request did not carry the first message: %+v", asked)
	}
	r.say(id, "A second message", 2)
	time.Sleep(200 * time.Millisecond)
	if len(asked) != 1 {
		t.Fatalf("a later answer asked for another title: %d requests", len(asked))
	}
}
