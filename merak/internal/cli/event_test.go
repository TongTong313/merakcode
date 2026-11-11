package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
)

func TestEventEmitUsesTheExistingIsolatedEngineAndExternalNamespace(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MERAKCODE_HOME", home)
	e, err := engine.New(engine.Deps{Workdir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := startAt(e, home)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	g, err := e.Groups.Create(context.Background(), group.Group{Kind: group.KindLocal, Name: "CI", Project: group.Project{Directory: t.TempDir()}, Leader: "leader"}, []group.Member{{ID: "leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Name: "Leader"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"ci.finished", "external.ci.finished"} {
		t.Run(kind, func(t *testing.T) {
			var output bytes.Buffer
			code := Run([]string{"event", "emit", "--group", string(g.ID), "--type", kind, "--payload", `{"status":"success"}`}, strings.NewReader(""), &output)
			if code != 0 {
				t.Fatalf("code=%d output=%q", code, output.String())
			}
			fact, err := e.GetEvent(context.Background(), event.ID(strings.TrimSpace(output.String())))
			if err != nil || fact.Type != "external.ci.finished" || fact.Actor.Kind != event.ActorExternal || string(fact.Payload) != `{"status":"success"}` {
				t.Fatalf("event=%+v, %v", fact, err)
			}
		})
	}
	var output bytes.Buffer
	if code := Run([]string{"event", "emit", "--group", string(g.ID), "--type", "ci.finished", "--payload", "{"}, strings.NewReader(""), &output); code != 2 {
		t.Fatalf("invalid JSON code=%d", code)
	}
}
