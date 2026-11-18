package cloudlink_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/TongTong313/merakcode/merak/cloudlink"
	"github.com/TongTong313/merakcode/merak/engine"
	"github.com/TongTong313/merakcode/merak/engine/agent/definition"
	"github.com/TongTong313/merakcode/merak/engine/agent/loop"
	"github.com/TongTong313/merakcode/merak/engine/agent/model"
	"github.com/TongTong313/merakcode/merak/engine/agent/model/fake"
	"github.com/TongTong313/merakcode/merak/engine/collab/group"
	"github.com/TongTong313/merakcode/merak/engine/collab/remote"
	"github.com/TongTong313/merakcode/merak/engine/collab/task"
	"github.com/TongTong313/merakcode/merak/engine/collab/wire"
	"github.com/TongTong313/merakcode/merak/engine/infra/event"
	"github.com/TongTong313/merakcode/merak/storage/memory"
	"github.com/TongTong313/merakcode/merak/testkit/enginetest"
	"github.com/TongTong313/merakcode/merak/testkit/testcloud"
)

func TestCloudMessageReachesTheRunningMemberAndIgnoresAnUnknownClaim(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	started := make(chan struct{})
	provider := fake.New(t,
		fake.Reply{Hold: make(chan struct{}), Expect: func(model.Request) error {
			close(started)
			return nil
		}},
		fake.Reply{Expect: func(request model.Request) error {
			body, err := json.Marshal(request.Messages)
			if err != nil {
				return err
			}
			if !strings.Contains(string(body), "Use the revised instructions.") {
				return errors.New("running member did not receive the cloud message")
			}
			if strings.Contains(string(body), "Ignore this unknown claim.") {
				return errors.New("unknown claim message reached the running member")
			}
			return nil
		}, Calls: []model.ToolCall{{ID: "report", Name: "submit_report", Input: json.RawMessage(`{"verdict":"done","summary":"Received the revised instructions.","artifacts":[],"checks":[]}`)}}},
	)
	peer := testcloud.New(t)
	directory := t.TempDir()
	deps := enginetest.Deps(t)
	deps.NewLink = func() wire.Link { return cloudlink.NewWebSocket() }
	deps.Store = memory.New()
	deps.Workdir = directory
	deps.Providers = map[string]model.Provider{"fake": provider}
	e, err := engine.New(deps)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Close()
	profile := definition.DefaultMerakCode()
	profile.ID, profile.Model.Provider = "message-worker", "fake"
	if _, err = e.SaveAgent(ctx, "owner", profile); err != nil {
		t.Fatal(err)
	}
	if _, err = e.CreateGroup(ctx, group.Group{ID: "source", Kind: group.KindLocal, Name: "Source", Leader: "leader", Project: group.Project{Directory: directory}}, []group.Member{
		{ID: "leader", Name: "Leader", Kind: group.MemberAgent, AgentRole: group.AgentLeader, Agent: "builtin-merakcode"},
		{ID: "worker", Name: "Worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Agent: profile.ID},
	}); err != nil {
		t.Fatal(err)
	}
	if err = e.ConnectCloud(ctx, peer.Credentials()); err != nil {
		t.Fatal(err)
	}
	claim := task.Claim{ID: "message-claim", Task: "message-task", Member: "worker", Session: "message-session", Status: task.ClaimActive}
	state := group.State{Group: group.Group{ID: "cloud-group", Kind: group.KindCloud, Name: "Cloud", Leader: "cloud-leader"}, Members: []group.Member{{ID: "worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker}}}
	card := task.Card{ID: claim.Task, Group: state.Group.ID, Title: "Wait for instructions", Workspace: "none", Claims: []task.Claim{claim}, Status: task.Running}
	stateBody, _ := json.Marshal(state)
	cardBody, _ := json.Marshal(card)
	scope := event.Scope{Group: card.Group, Task: card.ID}
	if err = peer.Send(ctx, wire.CloudInbound{Events: []event.Event{
		{ID: "cloud-created", Stream: "group:cloud-group", Seq: 1, Time: time.Now(), Type: group.Created, Scope: event.Scope{Group: card.Group}, Payload: stateBody},
		{ID: "cloud-started", Stream: "group:cloud-group", Seq: 2, Time: time.Now(), Type: task.Started, Scope: scope, Payload: cardBody},
	}, Assignment: &wire.DeviceAssignment{SourceGroup: "source", Member: "worker", Claim: claim, Session: claim.Session, Scope: scope, Packet: "Wait for revised instructions, then report."}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for _, message := range []wire.DeviceMessage{
		{Claim: "unknown-claim", Input: loop.Input{Actor: event.Actor{Kind: event.ActorHuman, ID: "owner"}, Parts: []model.Part{{Text: "Ignore this unknown claim."}}}},
		{Claim: claim.ID, Input: loop.Input{Actor: event.Actor{Kind: event.ActorHuman, ID: "owner"}, Parts: []model.Part{{Text: "Use the revised instructions."}}}},
	} {
		if err = peer.Send(ctx, wire.CloudInbound{Message: &message}); err != nil {
			t.Fatal(err)
		}
	}
	for {
		select {
		case fact := <-peer.Published:
			if fact.Type != remote.DeviceReported {
				continue
			}
			report, err := event.Decode[task.Report](fact)
			if err != nil || report.Claim != "message-claim" || report.Verdict != task.VerdictDone || report.Summary != "Received the revised instructions." {
				t.Fatalf("report = %+v, error = %v", report, err)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
