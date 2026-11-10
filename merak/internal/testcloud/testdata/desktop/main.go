package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/TongTong313/merakcode/merak/engine/event"
	"github.com/TongTong313/merakcode/merak/engine/group"
	"github.com/TongTong313/merakcode/merak/engine/permission"
	"github.com/TongTong313/merakcode/merak/internal/testcloud"
	"github.com/TongTong313/merakcode/merak/protocol"
)

func main() {
	peer := testcloud.Start()
	defer peer.Close()
	groups := map[event.ID]group.State{}
	var facts []event.Event
	emit := func(id event.ID, kind event.Type, payload any) event.Event {
		stream := event.Stream("group:" + id)
		seq := uint64(1)
		for _, fact := range facts {
			if fact.Stream == stream {
				seq = fact.Seq + 1
			}
		}
		body, _ := json.Marshal(payload)
		fact := event.Event{ID: event.NewID(), Time: time.Now(), Seq: seq, Stream: stream, Scope: event.Scope{Group: id}, Actor: event.Actor{Kind: event.ActorHuman, ID: "local-human"}, Type: kind, Payload: body}
		facts = append(facts, fact)
		_ = peer.Send(context.Background(), protocol.CloudInbound{Events: []event.Event{fact}})
		return fact
	}
	peer.Handle = func(request protocol.Message) (any, error) {
		switch request.Method {
		case "cloud.members":
			return append(peer.Members(),
				group.Member{ID: "shared-worker", Group: "remote-source", Device: "device-one", Name: "First remote worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Status: group.Idle},
				group.Member{ID: "shared-worker", Group: "remote-source", Device: "device-two", Name: "Second remote worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Status: group.Idle},
				group.Member{ID: "shared-worker", Group: "another-source", Device: "device-two", Name: "Third remote worker", Kind: group.MemberAgent, AgentRole: group.AgentWorker, Status: group.Idle},
			), nil
		case "group.create":
			var params protocol.GroupCreateParams
			if err := json.Unmarshal(request.Params, &params); err != nil {
				return nil, err
			}
			params.ID = event.NewID()
			for i := range params.Members {
				params.Members[i].Group = params.ID
			}
			state := group.State{Group: params.Group, Members: params.Members}
			groups[params.ID] = state
			emit(params.ID, group.Created, state)
			return params.Group, nil
		case "group.state":
			var params protocol.GroupIDParams
			_ = json.Unmarshal(request.Params, &params)
			return groups[params.Group], nil
		case "group.say":
			var params protocol.GroupSayParams
			_ = json.Unmarshal(request.Params, &params)
			fact := emit(params.Group, group.HumanSaid, params.Message)
			_ = peer.Send(context.Background(), protocol.CloudInbound{Cause: fact.ID, Scope: fact.Scope, Notice: &group.Notice{Kind: "info", To: []event.ID{"local-human"}, Text: "Cloud inbox notice"}})
			if params.Message.Text == "Approval pending" {
				_ = peer.Send(context.Background(), protocol.CloudInbound{Cause: "cloud-request", Scope: fact.Scope, Notice: &group.Notice{Kind: "permission", To: []event.ID{"local-human"}, Text: "Cloud approval"}})
			}
			if params.Message.Text == "Approval answered" {
				body, _ := json.Marshal(permission.Reply{Human: "local-human", Decision: permission.Allow})
				answer := event.Event{ID: "cloud-answer", Stream: "session:cloud-worker", Seq: 1, Time: time.Now(), Scope: event.Scope{Group: params.Group, Session: "cloud-worker"}, Type: permission.Replied, Cause: "cloud-request", Actor: event.Actor{Kind: event.ActorHuman, ID: "local-human"}, Payload: body}
				facts = append(facts, answer)
				_ = peer.Send(context.Background(), protocol.CloudInbound{Events: []event.Event{answer}})
			}
			return fact.ID, nil
		case "group.addMember":
			var params protocol.GroupAddMemberParams
			_ = json.Unmarshal(request.Params, &params)
			if params.Member.Group == "" || params.Member.Group == params.Group {
				return nil, errors.New("cloud members require their source group")
			}
			params.Member.Group = params.Group
			state := groups[params.Group]
			state.Members = append(state.Members, params.Member)
			groups[params.Group] = state
			emit(params.Group, group.MemberAdded, params.Member)
			return params.Member, nil
		case "events.find":
			var filter event.Filter
			_ = json.Unmarshal(request.Params, &filter)
			result := []event.Event{}
			for _, fact := range facts {
				if filter.Matches(fact) {
					result = append(result, fact)
				}
			}
			return result, nil
		case "events.read":
			var params protocol.EventsReadParams
			_ = json.Unmarshal(request.Params, &params)
			result := []event.Event{}
			for _, fact := range facts {
				if fact.Stream == params.Stream && fact.Seq >= params.From && (params.Limit == 0 || len(result) < params.Limit) {
					result = append(result, fact)
				}
			}
			return result, nil
		}
		return struct{}{}, nil
	}
	fmt.Println(peer.Credentials().Endpoint)
	_, _ = io.Copy(io.Discard, os.Stdin)
}
